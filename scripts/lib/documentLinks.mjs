import path from "node:path";
/** Classify a document link without fetching it or consulting a checkout outside its declared owners. */
export function documentTarget(document, target, owner) {
  const stripped = target.split(/[?#]/, 1)[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return { kind: "external", target };
  if (!stripped) return { kind: "local", owner, path: document };
  if (stripped.startsWith("/")) throw new Error("Document link requires an undeclared absolute filesystem root.");
  if (stripped.includes("\\")) throw new Error("Document link requires a nonportable filesystem path.");
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(document), decodeURIComponent(stripped)));
  if (!resolved.startsWith("../")) return { kind: "local", owner, path: resolved };
  const sibling = /^\.\.\/(docs|research)\/(.+)$/.exec(resolved);
  if (!sibling) throw new Error("Document link escapes declared docs/research owners.");
  return { kind: "local", owner: "foss-earth/" + sibling[1], path: sibling[2] };
}

/** A portable navigation address is not a release pin or a fetched-link result. */
export function publicOwnerDocumentTarget(target) {
  const url = new URL(target);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port || url.search) throw new Error("Undeclared public owner document address.");
  const match = /^\/foss-earth\/(docs|research)\/blob\/main\/(.+)$/.exec(url.pathname);
  if (!match) throw new Error("Undeclared public owner document address.");
  const pathname = decodeURIComponent(match[2]);
  if (pathname.startsWith("/") || pathname.includes("\\") || pathname.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Public document path escaped its owner.");
  return { owner: "foss-earth/" + match[1], path: pathname };
}

/** Read Markdown inline/reference links, excluding fenced examples. No IO. */
export function markdownTargets(text) {
  let fence = null;
  const prose = text.split(/\r?\n/).filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      return false;
    }
    return !fence;
  }).join("\n");
  const targets = [];
  const inline = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (const match of prose.matchAll(inline)) targets.push(match[1] ?? match[2]);
  const reference = /^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm;
  for (const match of prose.matchAll(reference)) targets.push(match[1] ?? match[2]);
  return targets;
}
