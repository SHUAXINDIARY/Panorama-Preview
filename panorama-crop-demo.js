import * as THREE from 'three'
import { Viewer } from '@photo-sphere-viewer/core'

const els = {
  fileInput: document.querySelector('#fileInput'),
  viewer: document.querySelector('#viewer'),
  yaw: document.querySelector('#yaw'),
  pitch: document.querySelector('#pitch'),
  fov: document.querySelector('#fov'),
  yawValue: document.querySelector('#yawValue'),
  pitchValue: document.querySelector('#pitchValue'),
  fovValue: document.querySelector('#fovValue'),
  width: document.querySelector('#width'),
  height: document.querySelector('#height'),
  presetMode: document.querySelector('#presetMode'),
  presetDescription: document.querySelector('#presetDescription'),
  captureCurrent: document.querySelector('#captureCurrent'),
  capturePreset: document.querySelector('#capturePreset'),
  clearResults: document.querySelector('#clearResults'),
  results: document.querySelector('#results'),
}

let viewer = null
let imageUrl = ''
let resultCount = 0

const degToRad = (value) => THREE.MathUtils.degToRad(Number(value))
const radToDeg = (value) => Math.round(THREE.MathUtils.radToDeg(value))
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const VIEW_PRESETS = {
  four: {
    description: '4 视角采用水平主方位：front/right/back/left，yaw 间隔 90deg，pitch=0deg。',
    views: [
      { name: 'front', yaw: 0, pitch: 0 },
      { name: 'right', yaw: 90, pitch: 0 },
      { name: 'back', yaw: 180, pitch: 0 },
      { name: 'left', yaw: -90, pitch: 0 },
    ],
  },
  six: {
    description: '6 视角采用立方体主方向：front/right/back/left/top/bottom。',
    views: [
      { name: 'front', yaw: 0, pitch: 0 },
      { name: 'right', yaw: 90, pitch: 0 },
      { name: 'back', yaw: 180, pitch: 0 },
      { name: 'left', yaw: -90, pitch: 0 },
      { name: 'top', yaw: 0, pitch: 90 },
      { name: 'bottom', yaw: 0, pitch: -90 },
    ],
  },
  nine: {
    description: '9 视角采用三行三列视角矩阵：yaw=-90/0/90deg，pitch=45/0/-45deg。',
    views: [
      { name: 'top-left', yaw: -90, pitch: 45 },
      { name: 'top-front', yaw: 0, pitch: 45 },
      { name: 'top-right', yaw: 90, pitch: 45 },
      { name: 'mid-left', yaw: -90, pitch: 0 },
      { name: 'mid-front', yaw: 0, pitch: 0 },
      { name: 'mid-right', yaw: 90, pitch: 0 },
      { name: 'bottom-left', yaw: -90, pitch: -45 },
      { name: 'bottom-front', yaw: 0, pitch: -45 },
      { name: 'bottom-right', yaw: 90, pitch: -45 },
    ],
  },
  twelve: {
    description: '12 视角采用水平环拍：pitch=0deg，yaw 从 0deg 开始每 30deg 一张。',
    views: Array.from({ length: 12 }, (_, index) => {
      const yaw = index * 30
      return {
        name: `ring-${String(index + 1).padStart(2, '0')}-${yaw}deg`,
        yaw,
        pitch: 0,
      }
    }),
  },
}

function updateLabels() {
  els.yawValue.textContent = `${els.yaw.value} deg`
  els.pitchValue.textContent = `${els.pitch.value} deg`
  els.fovValue.textContent = `${els.fov.value} deg`
}

function updatePresetDescription() {
  const preset = VIEW_PRESETS[els.presetMode.value]
  els.presetDescription.textContent = preset.description
}

function setButtonsEnabled(enabled) {
  els.captureCurrent.disabled = !enabled
  els.capturePreset.disabled = !enabled
}

function syncPreviewFromControls() {
  if (!viewer) return

  viewer.rotate({
    yaw: degToRad(els.yaw.value),
    pitch: degToRad(els.pitch.value),
  })
}

function syncControlsFromPreview() {
  if (!viewer) return

  const position = viewer.getPosition()
  els.yaw.value = clamp(radToDeg(position.yaw), -180, 180)
  els.pitch.value = clamp(radToDeg(position.pitch), -85, 85)
  updateLabels()
}

function getOutputSize() {
  return {
    width: clamp(Number(els.width.value) || 1200, 64, 4096),
    height: clamp(Number(els.height.value) || 800, 64, 4096),
  }
}

function clearEmptyState() {
  const empty = els.results.querySelector('.empty')
  if (empty) empty.remove()
}

function addResult({ name, blob }) {
  clearEmptyState()

  const url = URL.createObjectURL(blob)
  const filename = `${name}-${String(++resultCount).padStart(2, '0')}.jpg`

  const card = document.createElement('article')
  card.className = 'result'
  card.innerHTML = `
    <img src="${url}" alt="${filename}">
    <footer>
      <span>${filename}</span>
      <a href="${url}" download="${filename}">下载</a>
    </footer>
  `

  els.results.prepend(card)
}

async function cropPanorama({ name, yaw, pitch, fov, width, height }) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  })

  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  const loader = new THREE.TextureLoader()
  const texture = await loader.loadAsync(imageUrl)
  texture.colorSpace = THREE.SRGBColorSpace

  const geometry = new THREE.SphereGeometry(500, 96, 48)
  geometry.scale(-1, 1, 1)

  const material = new THREE.MeshBasicMaterial({ map: texture })
  scene.add(new THREE.Mesh(geometry, material))

  const camera = new THREE.PerspectiveCamera(fov, width / height, 1, 1000)
  camera.rotation.order = 'YXZ'
  camera.rotation.y = yaw
  camera.rotation.x = pitch

  renderer.render(scene, camera)

  const blob = await new Promise((resolve) => {
    renderer.domElement.toBlob(resolve, 'image/jpeg', 0.92)
  })

  geometry.dispose()
  material.dispose()
  texture.dispose()
  renderer.dispose()

  addResult({ name, blob })
}

async function captureCurrent() {
  const size = getOutputSize()

  await cropPanorama({
    name: 'current',
    yaw: degToRad(els.yaw.value),
    pitch: degToRad(els.pitch.value),
    fov: Number(els.fov.value),
    ...size,
  })
}

async function capturePresets() {
  const size = getOutputSize()
  const fov = Number(els.fov.value)
  const views = VIEW_PRESETS[els.presetMode.value].views

  for (const view of views) {
    await cropPanorama({
      name: view.name,
      yaw: degToRad(view.yaw),
      pitch: degToRad(view.pitch),
      fov,
      ...size,
    })
  }
}

async function loadPanorama(file) {
  if (imageUrl) URL.revokeObjectURL(imageUrl)
  imageUrl = URL.createObjectURL(file)

  if (viewer) {
    viewer.destroy()
  }

  viewer = new Viewer({
    container: els.viewer,
    panorama: imageUrl,
    navbar: ['zoom', 'move', 'fullscreen'],
    defaultYaw: 0,
    defaultPitch: 0,
    defaultZoomLvl: 30,
  })

  viewer.addEventListener('position-updated', syncControlsFromPreview)
  viewer.addEventListener('ready', () => {
    syncControlsFromPreview()
    setButtonsEnabled(true)
  }, { once: true })
}

els.fileInput.addEventListener('change', (event) => {
  const [file] = event.target.files
  if (file) loadPanorama(file)
})

for (const input of [els.yaw, els.pitch]) {
  input.addEventListener('input', () => {
    updateLabels()
    syncPreviewFromControls()
  })
}

els.fov.addEventListener('input', updateLabels)
els.presetMode.addEventListener('change', updatePresetDescription)
els.captureCurrent.addEventListener('click', captureCurrent)
els.capturePreset.addEventListener('click', capturePresets)
els.clearResults.addEventListener('click', () => {
  resultCount = 0
  els.results.innerHTML = '<div class="empty">裁切结果已清空。</div>'
})

updateLabels()
updatePresetDescription()
