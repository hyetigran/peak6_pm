/** Tiny indexer HTTP client shared by the demo loop and the prod scheduler. */
export function makeGetJson(base: string) {
  return async (path: string): Promise<any> => {
    const r = await fetch(`${base}${path}`);
    if (!r.ok) throw new Error(`${path} -> ${r.status}`);
    return r.json();
  };
}
