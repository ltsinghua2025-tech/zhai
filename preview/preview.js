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
