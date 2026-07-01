exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, body: "Method not allowed" };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" },
    body: JSON.stringify({
      url: process.env.SUPABASE_URL || "",
      anonKey: process.env.SUPABASE_ANON_KEY || ""
    })
  };
};
