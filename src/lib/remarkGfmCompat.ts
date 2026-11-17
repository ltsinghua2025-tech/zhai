import remarkGfm from "remark-gfm";

type Extension = {
  enter?: Record<string, unknown>;
  transforms?: unknown[];
};
type ExtensionTree = Extension | ExtensionTree[];
type ParserData = { fromMarkdownExtensions?: ExtensionTree[] };

function supportsLookbehind() {
  try {
    // Construct dynamically: old WebKit must be able to load this module.
    return new RegExp("(?<=a)b").test("ab");
  } catch {
    return false;
  }
}

function compatibleExtension(extension: ExtensionTree): ExtensionTree {
  if (Array.isArray(extension)) return extension.map(compatibleExtension);
  // GFM's autolink post-transform constructs a lookbehind regex on *every*
  // message, including plain text. Keep its token handlers (normal links),
  // and all table/task/footnote extensions, but omit that optional transform.
  if (extension.enter?.literalAutolink && extension.transforms) {
    return { ...extension, transforms: [] };
  }
  return extension;
}

export default function remarkGfmCompat(this: { data: () => object }) {
  remarkGfm.call(this);
  if (!supportsLookbehind()) {
    const data = this.data() as ParserData;
    data.fromMarkdownExtensions = data.fromMarkdownExtensions?.map(compatibleExtension);
  }
}
