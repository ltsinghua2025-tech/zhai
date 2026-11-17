import { loadPyodide } from './runtime/pyodide.mjs';

const runtimeBase = new URL('./runtime/', import.meta.url);
const maxSize = 10 * 1024 * 1024;
const docxWheel = 'python_docx-1.2.0-py3-none-any.whl';
let enginePromise;
let busy = false;

async function fetchAsset(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('运行资源暂时无法加载');
  return response;
}

async function loadEngine() {
  const runtime = await loadPyodide({ indexURL: runtimeBase.href });
  const [, wheel, ...modules] = await Promise.all([
    runtime.loadPackage(['lxml', 'typing-extensions']),
    fetchAsset(new URL(docxWheel, runtimeBase)).then(response => response.arrayBuffer()),
    ...['gongwen_layout.py', 'zhai_layout_helpers.py', '../browser_engine.py'].map(async name => {
      const content = await fetchAsset(new URL(name, runtimeBase)).then(response => response.text());
      return [name.split('/').pop(), content];
    }),
  ]);
  const packages = runtime.runPython('import site; site.getsitepackages()[0]');
  runtime.unpackArchive(wheel, 'zip', { extractDir: packages });
  for (const [name, content] of modules) {
    runtime.FS.writeFile(`${runtime.FS.cwd()}/${name}`, content);
  }
  runtime.runPython('from browser_engine import process_docx');
  return runtime;
}

self.addEventListener('message', async event => {
  const { type, id, fileName, data } = event.data || {};
  if (type !== 'format') return;
  const send = (kind, values, transfer = []) => self.postMessage({ type: kind, id, ...values }, transfer);
  if (busy) {
    send('error', { message: '正在处理文件，请等待当前任务完成。' });
    return;
  }
  if (typeof fileName !== 'string' || !/\.docx$/i.test(fileName) || !(data instanceof ArrayBuffer)
      || !data.byteLength || data.byteLength > maxSize) {
    send('error', { message: '请选择小于或等于 10 MB 的 DOCX 文件。' });
    return;
  }
  busy = true;
  try {
    if (!enginePromise) {
      send('progress', { message: '正在加载浏览器排版引擎，首次使用请稍候。' });
      enginePromise = loadEngine().catch(error => {
        enginePromise = undefined;
        throw error;
      });
    }
    const engine = await enginePromise;
    send('progress', { message: '正在排版并复核新文件。' });
    engine.globals.set('_zhai_input', new Uint8Array(data));
    let response;
    try {
      const result = engine.runPython('process_docx(bytes(_zhai_input))');
      try {
        response = result.toJs({ dict_converter: Object.fromEntries });
      } finally {
        result.destroy();
      }
    } finally {
      engine.globals.delete('_zhai_input');
    }
    if (response.error) {
      send('error', { message: response.error });
      return;
    }
    const output = Uint8Array.from(response.data).buffer;
    send('result', { data: output, notes: response.notes, changes: response.changes }, [output]);
  } catch {
    send('error', { message: enginePromise ? '文档处理未完成，请另存为 DOCX 后重试。' : '浏览器排版引擎加载失败，请检查网络后重试。' });
  } finally {
    busy = false;
  }
});
