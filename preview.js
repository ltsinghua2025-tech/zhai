const views = {
  before: {
    alt: "排版前样例。标题靠左，段落间距尚未统一。",
    caption: "排版前 · 标题靠左，段落间距与排版要求未统一",
  },
  after: {
    alt: "排版后样例。标题居中，正文按指定行距排列，保留原有粗体。",
    caption: "排版后 · 标题居中，正文固定 28 磅，原有加粗保留",
  },
};

const image = document.querySelector("#sample-image");
const caption = document.querySelector("#sample-caption");
const buttons = document.querySelectorAll("[data-view]");

for (const button of buttons) {
  button.addEventListener("click", () => {
    const name = button.dataset.view;
    const view = views[name];
    if (!view) return;
    image.src = `./assets/${name}.png`;
    image.alt = view.alt;
    caption.textContent = view.caption;
    for (const option of buttons) {
      option.setAttribute("aria-pressed", String(option === button));
    }
  });
}

const form = document.querySelector("#format-form");
const fileInput = document.querySelector("#format-file");
const submit = document.querySelector("#format-submit");
const sample = document.querySelector("#use-sample");
const status = document.querySelector("#format-status");
const notes = document.querySelector("#format-notes");
const download = document.querySelector("#format-download");
const docxType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let worker;
let timer;
let activeId = 0;
let outputName;
let downloadUrl;
let busy = false;

function showStatus(message, state = "working") {
  status.textContent = message;
  status.dataset.state = state;
  status.hidden = false;
}

function clearResult() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
  download.hidden = true;
  download.removeAttribute("href");
  notes.hidden = true;
  notes.replaceChildren();
}

function setBusy(value) {
  busy = value;
  submit.disabled = value;
  sample.disabled = value;
  fileInput.disabled = value;
  form.setAttribute("aria-busy", String(value));
}

function finish() {
  clearTimeout(timer);
  setBusy(false);
}

function stopWorker() {
  worker?.terminate();
  worker = undefined;
}

async function formatFile(file) {
  if (busy) return;
  clearResult();
  if (!file || !/\.docx$/i.test(file.name)) {
    showStatus("请选择 .docx 格式的 Word 文件。", "error");
    return;
  }
  if (file.size === 0 || file.size > 10 * 1024 * 1024) {
    showStatus("请选择不为空且不超过 10 MB 的 DOCX。", "error");
    return;
  }
  setBusy(true);
  showStatus("正在准备排版组件…");
  const id = ++activeId;
  outputName = `${file.name.replace(/\.docx$/i, "")}-公文排版.docx`;
  try {
    if (!worker) {
      worker = new Worker(new URL("./formatter-worker.js", location.href), { type: "module" });
      worker.onerror = () => {
        stopWorker();
        finish();
        showStatus("排版组件未能启动。请刷新后重试。", "error");
      };
      worker.onmessage = ({ data: reply }) => {
        if (reply.id !== activeId || !busy) return;
        if (reply.type === "progress") return showStatus(reply.message);
        finish();
        if (reply.type === "error") {
          showStatus(reply.message, "error");
        } else if (reply.type === "result") {
          downloadUrl = URL.createObjectURL(new Blob([reply.data], { type: docxType }));
          download.href = downloadUrl;
          download.download = outputName;
          download.hidden = false;
          for (const note of reply.notes || []) {
            const li = document.createElement("li");
            li.textContent = note;
            notes.appendChild(li);
          }
          notes.hidden = notes.childElementCount === 0;
          showStatus("排版完成。请下载并核对新文档。", "success");
        }
      };
    }
    const data = await file.arrayBuffer();
    timer = setTimeout(() => {
      stopWorker();
      finish();
      showStatus("排版超时。请检查网络或试用较小的 DOCX。", "error");
    }, 90_000);
    worker.postMessage({ type: "format", id, fileName: file.name, data }, [data]);
  } catch {
    stopWorker();
    finish();
    showStatus("无法读取文件。请重新选择 DOCX。", "error");
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void formatFile(fileInput.files[0]);
});
fileInput.addEventListener("change", () => {
  clearResult();
  status.hidden = true;
});
sample.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  fileInput.value = "";
  clearResult();
  showStatus("正在读取合成样例…");
  try {
    const response = await fetch("./assets/sample-original.docx");
    if (!response.ok) throw new Error("Sample unavailable");
    const file = new File([await response.blob()], "材料报送样例.docx", { type: docxType });
    setBusy(false);
    void formatFile(file);
  } catch {
    finish();
    showStatus("样例暂时无法加载，可选择自己的 DOCX。", "error");
  }
});
