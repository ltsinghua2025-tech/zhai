# Browser runtime notices

These unmodified upstream components allow ZHAI's document layout rules to run
inside the browser worker. The archive for each component is pinned in
`../build_browser_runtime.py`. `SHA256SUMS.txt` covers this runtime directory.

- Pyodide 314.0.8, MPL-2.0: [sources and release](https://github.com/pyodide/pyodide/releases/tag/314.0.8).
- CPython 3.14.2, PSF and bundled licenses: [sources](https://github.com/python/cpython/tree/v3.14.2).
- lxml 6.1.3 and bundled libraries, BSD and additional notices: [sources](https://github.com/lxml/lxml/tree/lxml-6.1.3).
- typing-extensions 4.15.0, PSF: [sources](https://github.com/python/typing_extensions/tree/4.15.0).
- python-docx 1.2.0, MIT: [sources](https://github.com/python-openxml/python-docx/tree/v1.2.0).

The runtime can be rebuilt with `python3 preview/build_browser_runtime.py`.
ZHAI's own layout code remains available under the repository license.
