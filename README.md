# 全景图视角预览与裁切方案

## 目标

对一张本地上传的 equirectangular 全景图实现三件事：

1. 渲染可拖拽的全景预览。
2. 判断用户当前正在看的视角。
3. 按当前视角或预设视角裁切出普通透视图片。

当前 demo 的分工是：

- Photo Sphere Viewer：负责交互预览。
- Three.js：负责离屏投影、超采样渲染和图片导出。
- 原生 `dialog`：负责裁切结果的大图预览。

## 当前视角判断方案

全景图视角使用球面坐标描述，核心参数是：

- `yaw`：水平旋转角，表示看向左/右/前/后的方向。
- `pitch`：垂直俯仰角，表示看向上/下。
- `fov`：视场角，表示截图范围宽窄。

在 Photo Sphere Viewer 中，用户拖动全景图后，可以通过 `viewer.getPosition()` 获取当前视角：

```js
const position = viewer.getPosition()

const currentView = {
  yaw: position.yaw,
  pitch: position.pitch,
  fov: Number(fovInput.value),
}
```

其中 `yaw` 和 `pitch` 是弧度值。界面展示时可以转成角度：

```js
const yawDeg = THREE.MathUtils.radToDeg(position.yaw)
const pitchDeg = THREE.MathUtils.radToDeg(position.pitch)
```

当前 demo 监听 `position-updated` 事件，把预览区域中的拖动结果同步到右侧滑块：

```js
viewer.addEventListener('position-updated', () => {
  const position = viewer.getPosition()

  yawInput.value = Math.round(THREE.MathUtils.radToDeg(position.yaw))
  pitchInput.value = Math.round(THREE.MathUtils.radToDeg(position.pitch))
})
```

如果用户直接拖动右侧滑块，则反向调用 `viewer.rotate()` 更新预览视角：

```js
viewer.rotate({
  yaw: THREE.MathUtils.degToRad(Number(yawInput.value)),
  pitch: THREE.MathUtils.degToRad(Number(pitchInput.value)),
})
```

这样可以保证：

- 用户拖动全景图时，控件同步变化。
- 用户拖动控件时，预览同步旋转。
- 导出当前视角时，使用的是界面上最新的 `yaw / pitch / fov`。

当前实现还会在 `fov` 变化时实时刷新导出尺寸说明，因为输出尺寸会根据原图分辨率和当前 `fov` 自动计算。

## 视角预设方案

批量裁切使用行业里常见的球面经纬度视角定义方式。

### 4 视角

用于生成水平主方向：

| 名称 | yaw | pitch |
|---|---:|---:|
| front | 0deg | 0deg |
| right | 90deg | 0deg |
| back | 180deg | 0deg |
| left | -90deg | 0deg |

### 6 视角

用于生成立方体主方向：

| 名称 | yaw | pitch |
|---|---:|---:|
| front | 0deg | 0deg |
| right | 90deg | 0deg |
| back | 180deg | 0deg |
| left | -90deg | 0deg |
| top | 0deg | 90deg |
| bottom | 0deg | -90deg |

### 9 视角

用于生成三行三列视角矩阵：

| 名称 | yaw | pitch |
|---|---:|---:|
| top-left | -90deg | 45deg |
| top-front | 0deg | 45deg |
| top-right | 90deg | 45deg |
| mid-left | -90deg | 0deg |
| mid-front | 0deg | 0deg |
| mid-right | 90deg | 0deg |
| bottom-left | -90deg | -45deg |
| bottom-front | 0deg | -45deg |
| bottom-right | 90deg | -45deg |

### 12 视角

用于生成水平环拍：

- `pitch = 0deg`
- `yaw` 从 `0deg` 开始
- 每 `30deg` 输出一张
- 共 12 张

```js
const twelveViews = Array.from({ length: 12 }, (_, index) => ({
  name: `ring-${String(index + 1).padStart(2, '0')}-${index * 30}deg`,
  yaw: index * 30,
  pitch: 0,
}))
```

## 裁切方案

裁切不是直接在二维图片上框选矩形，而是把全景图映射到球体内部，再用透视相机拍摄某个方向。

### 输出尺寸策略

输出视角图不再让用户手动输入宽高，而是在原图分辨率基础上自动计算。equirectangular 全景图的垂直方向覆盖 `180deg`，所以当前实现用原图的垂直像素密度估算视角图高度：

```js
const height = Math.round(sourceHeight * (fov / 180))
const width = Math.min(sourceWidth, Math.round(height * OUTPUT_ASPECT_RATIO))
```

其中 `OUTPUT_ASPECT_RATIO = 3 / 2`。也就是说：

- 原图越大，导出的视角图越大。
- `fov` 越大，视角图覆盖角度越大，输出尺寸也越大。
- 宽度按 `3:2` 视角图比例推导，并且不会超过原图宽度。
- 最小输出尺寸兜底到 `64px`，避免异常输入导致 canvas 尺寸无效。

示例：如果原图是 `8000x4000`，`fov=80deg`，输出高度约为 `4000 * 80 / 180 = 1778px`，输出宽度约为 `2667px`。

### 超采样策略

为了降低透视投影后的模糊和锯齿，导出时不是直接按最终尺寸渲染，而是先进行 2x 超采样：

1. 先计算最终输出尺寸。
2. 再根据显卡 `MAX_RENDERBUFFER_SIZE` 判断 WebGL 离屏画布能否放大到 2x。
3. WebGL 使用超采样尺寸渲染。
4. 通过 2D canvas 使用 `imageSmoothingQuality = 'high'` 缩放回最终输出尺寸。
5. 以 JPEG `0.95` 质量导出。

如果显卡限制不足，超采样倍率会自动降低，避免超过 WebGL 可渲染尺寸。

流程如下：

```text
本地全景图
  -> Three.js Texture
  -> 贴到内翻球体 SphereGeometry
  -> 根据原图分辨率和 fov 计算最终输出尺寸
  -> 根据显卡限制计算 2x 超采样渲染尺寸
  -> PerspectiveCamera 设置 yaw / pitch / fov
  -> WebGLRenderer 离屏渲染
  -> 2D canvas 高质量缩放回最终尺寸
  -> canvas.toBlob(image/jpeg, 0.95)
  -> 得到 jpg
```

核心尺寸计算：

```js
const OUTPUT_ASPECT_RATIO = 3 / 2
const EXPORT_SUPERSAMPLE_SCALE = 2

function getOutputSize() {
  const sourceWidth = Math.max(sourceImageSize.width, 64)
  const sourceHeight = Math.max(sourceImageSize.height, 64)
  const fov = clamp(Number(fovInput.value) || 80, 1, 180)
  const height = Math.round(sourceHeight * (fov / 180))
  const width = Math.min(sourceWidth, Math.round(height * OUTPUT_ASPECT_RATIO))

  return {
    width: Math.max(width, 64),
    height: Math.max(height, 64),
    scale: EXPORT_SUPERSAMPLE_SCALE,
  }
}

function getSupersampledSize({ width, height, maxSize }) {
  const scale = Math.min(
    EXPORT_SUPERSAMPLE_SCALE,
    maxSize / width,
    maxSize / height,
  )

  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}
```

核心裁切函数结构：

```js
async function cropPanorama({
  imageUrl,
  yaw,
  pitch,
  fov,
  width,
  height,
}) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  })

  const gl = renderer.getContext()
  const renderSize = getSupersampledSize({
    width,
    height,
    maxSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
  })

  renderer.setPixelRatio(1)
  renderer.setSize(renderSize.width, renderSize.height, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()

  const texture = await new THREE.TextureLoader().loadAsync(imageUrl)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy()

  const geometry = new THREE.SphereGeometry(500, 96, 48)
  geometry.scale(-1, 1, 1)

  const material = new THREE.MeshBasicMaterial({ map: texture })
  scene.add(new THREE.Mesh(geometry, material))

  const camera = new THREE.PerspectiveCamera(
    fov,
    width / height,
    1,
    1000,
  )

  camera.rotation.order = 'YXZ'
  camera.rotation.y = yaw
  camera.rotation.x = pitch

  renderer.render(scene, camera)

  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = width
  outputCanvas.height = height

  const outputContext = outputCanvas.getContext('2d')
  outputContext.imageSmoothingEnabled = true
  outputContext.imageSmoothingQuality = 'high'
  outputContext.drawImage(renderer.domElement, 0, 0, width, height)

  const blob = await new Promise((resolve) => {
    outputCanvas.toBlob(resolve, 'image/jpeg', 0.95)
  })

  geometry.dispose()
  material.dispose()
  texture.dispose()
  renderer.dispose()

  return blob
}
```

批量裁切时遍历视角预设即可：

```js
const size = getOutputSize()

for (const view of views) {
  const blob = await cropPanorama({
    imageUrl,
    yaw: THREE.MathUtils.degToRad(view.yaw),
    pitch: THREE.MathUtils.degToRad(view.pitch),
    fov,
    ...size,
  })

  addResult(view.name, blob)
}
```

## 渲染预览方案

预览使用 Photo Sphere Viewer，因为它已经处理好了全景拖拽、缩放、全屏、移动端手势等交互。

上传图片后，通过 `URL.createObjectURL(file)` 得到本地 blob 地址，然后初始化 viewer：

```js
const imageUrl = URL.createObjectURL(file)

const viewer = new Viewer({
  container: document.querySelector('#viewer'),
  panorama: imageUrl,
  navbar: ['zoom', 'move', 'fullscreen'],
  defaultYaw: 0,
  defaultPitch: 0,
  defaultZoomLvl: 30,
})
```

预览层主要负责“看”和“选视角”，截图导出仍由独立的 Three.js 离屏渲染完成。当前 demo 额外对 Photo Sphere Viewer 的 renderer 设置了更高像素比，用来提升屏幕预览清晰度：

```js
const PREVIEW_SUPERSAMPLE_SCALE = 2

function getPreviewPixelRatio() {
  return Math.min((window.devicePixelRatio || 1) * PREVIEW_SUPERSAMPLE_SCALE, 4)
}

function tunePreviewResolution() {
  const renderer = viewer?.renderer?.renderer
  if (!renderer?.setPixelRatio || !renderer?.setSize) return

  renderer.setPixelRatio(getPreviewPixelRatio())
  renderer.setSize(viewerElement.clientWidth, viewerElement.clientHeight, false)
  viewer.needsUpdate?.()
}
```

`resize` 时会重新调整预览画布尺寸，避免窗口变化后预览回到低分辨率。

推荐职责划分：

| 模块 | 职责 |
|---|---|
| Photo Sphere Viewer | 全景预览、拖拽、缩放、同步当前视角、高清预览画布 |
| Three.js | 离屏投影、超采样裁切当前视角、批量生成预设视角 |
| UI 控件 | 管理 yaw、pitch、fov、视角预设、显示自动导出尺寸 |

## 裁切结果预览

裁切完成后，demo 会把每个 `Blob` 转成 object URL：

```js
const url = URL.createObjectURL(blob)
```

结果卡片中显示缩略图和下载链接：

```js
card.innerHTML = `
  <img src="${url}" alt="${filename}">
  <footer>
    <span>${filename}</span>
    <a href="${url}" download="${filename}">下载</a>
  </footer>
`
```

缩略图可以点击放大查看。当前实现使用原生 `dialog`：

```js
function openImagePreview({ url, filename }) {
  previewImage.src = url
  previewImage.alt = filename
  imagePreview.showModal()
}
```

关闭方式包括：

- 点击右上角“关闭”按钮。
- 点击预览背景。
- 浏览器原生支持时按 `Esc`。

## 注意事项

1. 上传图片建议使用 2:1 比例的 [equirectangular](https://panoramagenerator.com/zh/blog/equirectangular-image-explained) 全景图，例如 `6000x3000`。
2. 如果用远程图片裁切，需要远程图片允许 CORS，否则 canvas 导出会失败。
3. 当前 demo 使用本地上传图片生成 blob URL，因此不会触发跨域污染。
4. 输出尺寸根据原图垂直像素密度和 `fov` 自动计算，不提供手动宽高输入。
5. `fov` 越小画面越接近长焦，导出尺寸也越小；`fov` 越大画面越广角，导出尺寸也越大。
6. 2x 超采样会增加显存和导出时间，浏览器会受显卡最大 renderbuffer 尺寸限制。
7. 12 视角水平环拍通常建议使用较小或中等 `fov`，否则相邻截图重叠会比较明显。
8. 如果裁切结果与预览方向左右相反，可以在 Three.js 裁切函数中把 `camera.rotation.y = yaw` 改为 `camera.rotation.y = -yaw` 做坐标系校准。
9. 点击裁切结果缩略图只负责放大预览，下载仍通过结果卡片底部的下载链接完成。

