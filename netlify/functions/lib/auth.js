async function getAuthenticatedUser(event) {
  const token = String(event.headers.authorization || event.headers.Authorization || "").replace(/^Bearer\s+/i, "").trim();
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_ANON_KEY;
  if (!token || !url || !key) return null;

  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: key }
  });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id && user?.email ? { id: user.id, email: user.email } : null;
}

module.exports = { getAuthenticatedUser };
