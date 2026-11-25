// Sequential ids ("t1", "t2", ...). Good enough for an in-memory store.
export function createIdGenerator(prefix = 't') {
    let n = 0;
    return () => `${prefix}${++n}`;
}
