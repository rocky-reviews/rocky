/**
 * The change tree (H4-12): the PR's changed folders at a glance, built from the analysis
 * document already loaded (no server call). Only folders with changes appear, single-child
 * folder chains collapse ("billing/src"), root-level files go in "(root config)", the files to
 * ignore (low and noise, as the briefing's Ignore chip) sit in one group at the bottom and the
 * files the AI could not analyse in a visible group of their own. Inside a folder the critical
 * and important files are named and the rest fold into one line. Pure, so it is tested without
 * a DOM.
 */
/** What the tree reads from a document; an `AnalysisDocument` is one. */
export type TreeSource = {
  readonly triage: {
    readonly files: readonly { readonly path: string; readonly level: string }[];
    readonly noise: readonly { readonly path: string }[];
  };
  readonly provenance: {
    readonly files: readonly {
      readonly path: string;
      readonly status: string;
      readonly additions: number;
      readonly deletions: number;
    }[];
    readonly unanalysed: readonly { readonly path: string }[];
  };
};

/** The levels the tree draws; low and noise are "ignore", outside the tree. */
export type TreeLevel = "critical" | "important" | "normal";
export type TreeFileLevel = TreeLevel | "unanalysed" | "ignore";

export type TreeFile = {
  path: string;
  /** The last path segment. */
  name: string;
  level: TreeFileLevel;
  additions: number;
  deletions: number;
  test: boolean;
};

export type FolderSummary = {
  files: number;
  /** Critical plus important: the files to read carefully. */
  toRead: number;
  worst: TreeLevel;
  additions: number;
  deletions: number;
  /**
   * Every changed file under it was added, counting the ignored and unanalysed files the tree
   * leaves out (a folder with a modified lockfile or generated file is not new).
   */
  isNew: boolean;
  byLevel: Record<TreeLevel, number>;
};

export type TreeFolder = {
  /** Distinct within one tree, safe as an element id suffix. */
  id: string;
  /** The label: a collapsed chain joins its segments ("billing/src"). */
  name: string;
  /** The folder's full path ("" for the root config node). */
  path: string;
  folders: TreeFolder[];
  /** Its own critical and important files, riskiest then biggest first. */
  key: TreeFile[];
  /** Its other own files, biggest first. */
  rest: TreeFile[];
  restTests: number;
  /** Whether `rest` folds into "+ N more files" (else it is listed). */
  foldRest: boolean;
  summary: FolderSummary;
};

export type ChangeTree = {
  /** Every file in the PR. */
  total: number;
  /** Folders that directly hold a changed file, any file (the root counts once), as `total`. */
  folderCount: number;
  toRead: number;
  /** Top folders, biggest first, "(root config)" last. */
  folders: TreeFolder[];
  /** The top folder that starts expanded. */
  expanded: string | undefined;
  unanalysed: TreeFile[];
  ignored: { files: TreeFile[]; additions: number; deletions: number };
};

export const ROOT_CONFIG = "(root config)";

const RANK: Record<TreeFileLevel, number> = {
  critical: 4,
  important: 3,
  normal: 2,
  unanalysed: 1,
  ignore: 0,
};

/** Test files by name (`x.test.ts`, `x_test.go`, `x.spec.tsx`) or folder (`tests/`, `__tests__/`). */
export const isTestPath = (path: string): boolean =>
  /(^|\/)(__tests__|tests?)\//.test(path) || /[._](test|spec)\.[^/]+$/.test(path);

const lines = (f: { additions: number; deletions: number }) => f.additions + f.deletions;
const byLevelThenSize = (a: TreeFile, b: TreeFile) =>
  RANK[b.level] - RANK[a.level] || lines(b) - lines(a) || a.path.localeCompare(b.path);
const bySize = (a: TreeFile, b: TreeFile) => lines(b) - lines(a) || a.path.localeCompare(b.path);
const isKey = (f: TreeFile) => f.level === "critical" || f.level === "important";

type Node = { name: string; path: string; dirs: Map<string, Node>; files: TreeFile[] };

/** Folders with a single child folder and no files of their own merge into it. */
const squash = (node: Node): Node => {
  for (const [k, d] of node.dirs) node.dirs.set(k, squash(d));
  const [only] = node.dirs.values();
  if (node.name !== "" && node.files.length === 0 && node.dirs.size === 1 && only !== undefined)
    return { ...only, name: `${node.name}/${only.name}` };
  return node;
};

const allFiles = (node: Node): TreeFile[] => [
  ...node.files,
  ...[...node.dirs.values()].flatMap(allFiles),
];

const summarise = (files: readonly TreeFile[], isNew: boolean): FolderSummary => {
  const byLevel: Record<TreeLevel, number> = { critical: 0, important: 0, normal: 0 };
  for (const f of files) if (f.level in byLevel) byLevel[f.level as TreeLevel] += 1;
  return {
    files: files.length,
    toRead: byLevel.critical + byLevel.important,
    worst: byLevel.critical > 0 ? "critical" : byLevel.important > 0 ? "important" : "normal",
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    isNew,
    byLevel,
  };
};

const weight = (f: TreeFolder) => f.summary.additions + f.summary.deletions;
const byWeight = (a: TreeFolder, b: TreeFolder) =>
  weight(b) - weight(a) || b.summary.files - a.summary.files || a.name.localeCompare(b.name);
const riskier = (a: TreeFolder, b: TreeFolder) =>
  RANK[b.summary.worst] - RANK[a.summary.worst] ||
  b.summary.toRead - a.summary.toRead ||
  byWeight(a, b);

export const changeTree = (doc: TreeSource): ChangeTree => {
  const facts = new Map(doc.provenance.files.map((f) => [f.path, f]));
  const added = new Set(
    doc.provenance.files.filter((f) => f.status === "added").map((f) => f.path),
  );
  const file = (path: string, level: TreeFileLevel): TreeFile => ({
    path,
    name: path.split("/").at(-1) ?? path,
    level,
    additions: facts.get(path)?.additions ?? 0,
    deletions: facts.get(path)?.deletions ?? 0,
    test: isTestPath(path),
  });

  const shown: TreeFile[] = [];
  const ignored: TreeFile[] = doc.triage.noise.map((n) => file(n.path, "ignore"));
  for (const f of doc.triage.files) {
    if (f.level === "critical" || f.level === "important" || f.level === "normal")
      shown.push(file(f.path, f.level));
    else ignored.push(file(f.path, "ignore"));
  }
  const unanalysed = doc.provenance.unanalysed.map((f) => file(f.path, "unanalysed"));
  const every = [...shown, ...ignored, ...unanalysed].map((f) => f.path);
  /** Whether every changed file under a folder ("" for the root's own files) was added. */
  const allAdded = (path: string) =>
    every
      .filter((p) => (path === "" ? !p.includes("/") : p.startsWith(`${path}/`)))
      .every((p) => added.has(p));

  const root: Node = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of shown) {
    let node = root;
    for (const part of f.path.split("/").slice(0, -1)) {
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = {
          name: part,
          path: node.path === "" ? part : `${node.path}/${part}`,
          dirs: new Map(),
          files: [],
        };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(f);
  }
  const squashed = squash(root);

  let ids = 0;
  const folder = (node: Node): TreeFolder => {
    const id = `f${ids++}`;
    const key = node.files.filter(isKey).toSorted(byLevelThenSize);
    const rest = node.files.filter((f) => !isKey(f)).toSorted(bySize);
    return {
      id,
      name: node.name,
      path: node.path,
      folders: [...node.dirs.values()].map(folder).toSorted(byWeight),
      key,
      rest,
      restTests: rest.filter((f) => f.test).length,
      foldRest: rest.length > 0 && !(key.length === 0 && rest.length <= 2),
      summary: summarise(allFiles(node), allAdded(node.path)),
    };
  };
  const folders = [...squashed.dirs.values()].map(folder).toSorted(byWeight);
  if (squashed.files.length > 0)
    folders.push(folder({ name: ROOT_CONFIG, path: "", dirs: new Map(), files: squashed.files }));

  return {
    total: every.length,
    folderCount: new Set(every.map((p) => p.split("/").slice(0, -1).join("/"))).size,
    toRead: shown.filter(isKey).length,
    folders,
    expanded: folders.toSorted(riskier)[0]?.id,
    unanalysed,
    ignored: {
      files: ignored.toSorted(bySize),
      additions: ignored.reduce((n, f) => n + f.additions, 0),
      deletions: ignored.reduce((n, f) => n + f.deletions, 0),
    },
  };
};

export type OpenState = {
  folders: ReadonlySet<string>;
  /** Folders whose folded files are listed. */
  more: ReadonlySet<string>;
  ignored: boolean;
};

/**
 * What the tree shows when it opens: the default folder and, inside it, the folders down to its
 * files to read (so they are named, not behind another caret), plus whatever reveals the
 * selected file (its folders, its folder's folded files, or the ignored group).
 */
export const initialOpen = (tree: ChangeTree, selected: string | null): OpenState => {
  const folders = new Set<string>();
  const openToRead = (f: TreeFolder) => {
    folders.add(f.id);
    for (const child of f.folders) if (child.summary.toRead > 0) openToRead(child);
  };
  const first = tree.folders.find((f) => f.id === tree.expanded);
  if (first !== undefined) openToRead(first);
  const more = new Set<string>();
  const reveal = (list: readonly TreeFolder[], trail: readonly string[]): boolean =>
    list.some((f) => {
      const here = [...trail, f.id];
      if (f.key.some((x) => x.path === selected) || f.rest.some((x) => x.path === selected)) {
        for (const id of here) folders.add(id);
        if (f.foldRest && f.rest.some((x) => x.path === selected)) more.add(f.id);
        return true;
      }
      return reveal(f.folders, here);
    });
  if (selected !== null) reveal(tree.folders, []);
  return { folders, more, ignored: tree.ignored.files.some((f) => f.path === selected) };
};
