# Live2D Cubism 5.3 Runtime

MochiPaw vendors the official Cubism Web SDK `5-r.5` runtime. The Framework
source is pinned to commit `198a3769c26ca3d7b600e932590433badd392edd` from the
official repository:

- Repository: https://github.com/Live2D/CubismWebFramework
- SDK archive: https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip
- Core source: https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js
- Core release date: 2026-04-02
- Core SHA-256: `8741F739779B5D5210872BD3D7D99F0F1E56E6C87409E7D26D6BB4B80AA1EF47`

The Core file is installed at `public/js/live2dcubismcore.min.js`. The
Framework and the local Pixi compatibility layer are under
`src/vendor/easy-live2d`. The official 5.3 WebGL shader resources are under
`public/js/cubism5/shaders` and are served from `/js/cubism5/shaders/`.

This runtime uses the 5.3 Core and Framework together. Drawable blend modes,
alpha blend modes, reverse masks, and Part Offscreen Drawing are delegated to
the official Framework renderer. The application wrapper only owns Pixi
integration, model resources, interaction, diagnostics, and lifecycle.

## License

The Cubism Web Framework is distributed under the Live2D Open Software License.
The Cubism Core is distributed under the Live2D Proprietary Software License.
The applicable license texts and redistribution notice are kept with the
vendored files:

- `src/vendor/easy-live2d/Framework/LICENSE.md`
- `public/js/cubism5/LICENSE.md`
- `public/js/cubism5/RedistributableFiles.txt`

Live2D SDK licensing terms still apply to distributions of this application.
In particular, business users may need a Cubism SDK Release License; this
repository does not relicense the Live2D SDK files.

## Diagnostics

`Live2DSprite.getRuntimeDiagnostics()` exposes Core/MOC versions, drawable and
offscreen counts, frame timing, and WebGL error counts. MOC version checks and
WebGL2 initialization failures are reported as `Live2DLoadError` instances.
