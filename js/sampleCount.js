export function countUniqueCaptures(examples){
  const seen = new Set();
  for (const example of examples){
    const id = example.captureId || example.syncId;
    seen.add(id ? `id:${id}` : example);
  }
  return seen.size;
}
