# 全景图视角预览与裁切方案

## 目标

对一张本地上传的 equirectangular 全景图实现三件事：

1. 渲染可拖拽的全景预览。
2. 判断用户当前正在看的视角。
3. 按当前视角或预设视角裁切出普通透视图片。

当前 demo 的分工是：

- Photo Sphere Viewer：负责交互预览。
- Three.js：负责离屏渲染和图片导出。

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

流程如下：

```text
本地全景图
  -> Three.js Texture
  -> 贴到内翻球体 SphereGeometry
  -> PerspectiveCamera 设置 yaw / pitch / fov
  -> WebGLRenderer 离屏渲染
  -> canvas.toBlob()
  -> 得到 jpg/png
```

核心裁切函数：

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

  renderer.setPixelRatio(1)
  renderer.setSize(width, height, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()

  const texture = await new THREE.TextureLoader().loadAsync(imageUrl)
  texture.colorSpace = THREE.SRGBColorSpace

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

  const blob = await new Promise((resolve) => {
    renderer.domElement.toBlob(resolve, 'image/jpeg', 0.92)
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
for (const view of views) {
  const blob = await cropPanorama({
    imageUrl,
    yaw: THREE.MathUtils.degToRad(view.yaw),
    pitch: THREE.MathUtils.degToRad(view.pitch),
    fov,
    width,
    height,
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

预览层只负责“看”和“选视角”，不负责截图导出。这样可以避免依赖 Photo Sphere Viewer 的内部 renderer API。

推荐职责划分：

| 模块 | 职责 |
|---|---|
| Photo Sphere Viewer | 全景预览、拖拽、缩放、同步当前视角 |
| Three.js | 离屏投影、裁切当前视角、批量生成预设视角 |
| UI 控件 | 管理 yaw、pitch、fov、输出宽高、视角预设 |

## 注意事项

1. 上传图片建议使用 2:1 比例的 equirectangular 全景图，例如 `6000x3000`。
2. 如果用远程图片裁切，需要远程图片允许 CORS，否则 canvas 导出会失败。
3. 当前 demo 使用本地上传图片生成 blob URL，因此不会触发跨域污染。
4. `fov` 越小画面越接近长焦，越大画面越广角。
5. 12 视角水平环拍通常建议使用较小或中等 `fov`，否则相邻截图重叠会比较明显。
6. 如果裁切结果与预览方向左右相反，可以在 Three.js 裁切函数中把 `camera.rotation.y = yaw` 改为 `camera.rotation.y = -yaw` 做坐标系校准。

## 当前文件

- Demo 文件：`panorama-crop-demo.html`
- 方案文档：`panorama-view-crop-plan.md`
