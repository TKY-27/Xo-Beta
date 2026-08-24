/**
 * Micro-benchmark: raw WebGL2 fill throughput in THIS browser — a fullscreen
 * quad with PBR-ish fragment load (texture fetches + math) at 1600x900.
 * Establishes the environment's ceiling independent of the game.
 * Run: npx tsx tests/browser/probe-fill.ts
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

async function main(): Promise<void> {
  const server = await createServer({ server: { port: 5199 }, logLevel: 'silent' });
  await server.listen();
  const variant = process.env.VARIANT ?? 'default';
  console.log(variant, 'launching');
  const browser = await chromium.launch({
    channel: variant === 'chrome' ? 'chrome' : undefined,
    args: variant === 'metal' ? ['--use-angle=metal', '--enable-gpu'] : [],
    timeout: 30000,
  });
  console.log(variant, 'launched');
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  console.log(variant, 'page');
  await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  console.log(variant, 'goto done');
  const result = await page.evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600; canvas.height = 900;
    const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
    if (!gl) return 'no webgl2';
    const vs = '#version 300 es\\nin vec2 p; out vec2 uv; void main(){ uv=p*0.5+0.5; gl_Position=vec4(p,0.,1.); }';
    const fs = \`#version 300 es
      precision highp float;
      in vec2 uv; out vec4 o;
      uniform sampler2D t0, t1;
      uniform float t;
      void main(){
        vec3 c = vec3(0.);
        for (int i = 0; i < 6; i++) {
          float fi = float(i);
          vec2 suv = uv * (1.0 + fi * 0.13) + vec2(t * 0.01 * fi, -t * 0.013 * fi);
          c += texture(t0, suv).rgb * 0.16;
          c += texture(t1, suv * 1.7).rgb * 0.08;
        }
        float d = length(uv - 0.5);
        c *= smoothstep(0.9, 0.2, d);
        c = pow(c, vec3(0.4545));
        o = vec4(c, 1.0);
      }\`;
    const mk = (sh, src) => { const s = gl.createShader(sh); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const mkTex = (seed) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      const px = new Uint8Array(256 * 256 * 4);
      let s = seed;
      for (let i = 0; i < px.length; i++) { s = (s * 16807) % 2147483647; px[i] = s & 0xff; }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
      return t;
    };
    gl.uniform1i(gl.getUniformLocation(prog, 't0'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 't1'), 1);
    gl.activeTexture(gl.TEXTURE0); mkTex(12345);
    gl.activeTexture(gl.TEXTURE1); mkTex(6789);
    gl.uniform1f(gl.getUniformLocation(prog, 't'), 1);
    const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
    for (let i = 0; i < 30; i++) draw(); // warmup
    gl.finish();
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 2000) {
      for (let b = 0; b < 50; b++) draw();
      gl.finish();
      n += 50;
    }
    const dt = (performance.now() - t0) / 1000;
    const mpx = (n * 1.44) / dt / 1000;
    return JSON.stringify({ draws: n, seconds: Math.round(dt * 10) / 10, mpxPerSec: Math.round(mpx * 10) / 10, renderer: gl.getParameter(gl.RENDERER) });
  })()`);
  console.log(variant, result);
  await browser.close();
  await server.close();
}

void main().catch((e) => { console.error(e); process.exit(1); });
