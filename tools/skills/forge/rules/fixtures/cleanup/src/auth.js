export const login = (u, p) => fetch("/api/login", { method: "POST", body: JSON.stringify({ u, p }) })
