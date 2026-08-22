# Third-Party Notices

Xo Beta includes the following third-party software. All are distributed under
permissive licenses compatible with this project's MIT release.

---

## three.js

- **Version:** 0.185.1
- **License:** MIT
- **Source:** https://github.com/mrdoob/three.js
- **Used for:** WebGL rendering, scene graph, post-processing.

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Rapier3D (@dimforge/rapier3d-compat)

- **Version:** 0.20.0
- **License:** Apache-2.0
- **Source:** https://github.com/dimforge/rapier
- **Used for:** WASM physics (character controllers, colliders, queries).

```
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

A copy of the Apache-2.0 license text is available at the URL above and from
https://www.apache.org/licenses/LICENSE-2.0.txt

## Development-only tooling

Build/test/QA tooling (Vite, TypeScript, Vitest, Playwright, license-checker)
is used during development only and is not distributed with the game bundle;
each is MIT/Apache-2.0 licensed by its respective authors.

---

**Game assets:** every visual, audio and map asset shipped with Xo Beta is
*original work generated procedurally at runtime by this codebase* — there are
no third-party art or sound assets of any kind. See `docs/ASSET_MANIFEST.md`.
