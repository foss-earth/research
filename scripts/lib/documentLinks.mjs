import path from "node:path";
/** Classify a document link without fetching it or consulting a checkout outside its declared owners. */
export function documentTarget(document, target, owner) {
  const stripped = target.split(/[?#]/, 1)[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return { kind: "external", target };
  if (!stripped) return { kind: "local", owner, path: document };
  if (stripped.startsWith("/")) throw new Error("Document link requires an undeclared absolute filesystem root.");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(document), decodeURIComponent(stripped)));
  if (!resolved.startsWith("../")) return { kind: "local", owner, path: resolved };
  const sibling = /^\.\.\/(docs|research)\/(.+)$/.exec(resolved);
  if (!sibling) throw new Error("Document link escapes declared docs/research owners.");
  return { kind: "local", owner: "foss-earth/" + sibling[1], path: sibling[2] };
}
