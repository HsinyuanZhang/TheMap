# 摩纳哥地图

这是一个纯静态的单页地图。地图数据、地点文字、样式和字体字形都随仓库提供；浏览器运行时只从当前站点读取资源，不使用在线底图、瓦片、字体、API 或遥测服务。

## 本地运行与构建

需要 Node.js 22 和 npm。

```sh
npm ci
npm run dev
```

构建前端并生成、校验数据：

```sh
npm run build:data
npm run validate
npm test
npm run build
```

构建产物位于 `dist/`。`npm run build` 会生成 GeoJSON、运行校验、执行 TypeScript 检查，再运行 Vite 构建。

## 地图数据

`data/source.ts` 是可替换的紧凑源定义，坐标单位为公里，原点海峡交易所对应 `(-150.0, 40.0)`。运行 `npm run build:data` 会用固定种子生成 `public/data/` 中的八个 GeoJSON 文件。不要直接编辑生成文件。

数据目前使用简化示意几何：城区范围、主要地点、公园、公路和地铁线路均可定位与点击；城区多为规则分区，海岸和港湾未细化，街区拓扑及建筑密度也未完成。后续可在源定义中替换这些几何，不需要更改地图数据格式或面板接口。

## 新增地点

1. 在 `content/places/<id>.md` 新建文件，使用 `id`、`name`、`type`、`district` 四个 frontmatter 字段。
2. 正文只加入经作者确认的设定文字；未知的所属区填写「待定」。
3. 在 `data/source.ts` 的对应要素定义中使用相同 `id` 和 `name`。点位加入 `points`，公园加入 `parks`，街道加入 `roads`；行政区和邻区分别加入 `districts` 或 `land`。若地点需要地标建筑，在 `data/build.ts` 增加尺寸和高度配置，建筑位置与名称按 id 从 `points` 读取。
4. 若改动了经确认的介绍文字，同时更新 `tests/content.fixture.json` 中的核对项。

城区与邻区由 `districts`、`land` 定义；点位在 `points` 中定义，公园在 `parks` 中定义，道路在 `roads` 中定义。一个地点可同时对应点位和地标建筑或道路，以便在不同缩放级别点击。

## 修改地铁

在 `data/source.ts` 修改 `stations` 中的坐标或 `transitLines` 中的站点顺序和线路颜色。线路几何按站点顺序从 `stations` 坐标自动生成，不要维护重复的线路坐标。站点线路归属、换乘关系及前后站顺序都从这份定义生成。站名、颜色或站点次序有经作者确认的变化时，也更新 `tests/transit.fixture.json`。运行 `npm run build:data`、`npm run validate` 和 `npm test`。

## 地图文字与字体

地点 Markdown 由 Vite 作为本地原文打包。界面使用系统字体；中文地图字形由浏览器本地汉字字体渲染。拉丁地图字形采用仓库内的 DejaVu Sans 字体生成，PBF 字形位于 `public/fonts/DejaVu Sans/`。`npm run build:fonts` 可从 `assets/fonts/DejaVuSans.ttf` 重建该字形范围。字体来源与授权文本见 `assets/fonts/LICENSE.txt`；字体项目来源为 [DejaVu Fonts](https://dejavu-fonts.github.io/)。

## 部署

仓库包含 Vercel Vite 预设配置，静态输出目录为 `dist/`。在 Vercel 项目设置中连接仓库并选择 `main` 分支作为生产分支；推送到该分支后由 Vercel 自动构建。无需配置 API key、环境变量或后端服务。

## 依赖与用途

运行时依赖均随站点构建，不会从第三方域名动态加载：

- `maplibre-gl`：交互式矢量地图渲染、相机、图层和比例尺；BSD-3-Clause。
- `marked`：本地 Markdown 渲染；MIT。
- `dompurify`：清理渲染后的 HTML；Apache-2.0 或 MPL-2.0。

开发依赖：

- `vite`（MIT）、`typescript`（Apache-2.0）、`tsx`（MIT）：开发服务器、构建及 TypeScript 数据脚本。
- `@turf/turf`：构建时 GeoJSON 几何有效性、覆盖关系和相交校验；MIT。
- `fontnik`：把授权字体生成 MapLibre 所需的本地 PBF 字形；随包提供 BSD 许可证文本。
- `@types/geojson`、`@types/node`：开发期类型定义；MIT。

地图范围、各区与地点的描述、地铁和公路名称均来自随项目给定的设定文本。未知的行政归属在地点元数据中标记为「待定」，未扩写设定。
