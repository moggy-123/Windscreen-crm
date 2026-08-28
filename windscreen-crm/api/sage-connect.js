// Serverless function — this is what the app's "Connect to Sage" button links to.
// It builds the correct Sage authorization URL (using your app's client ID) and sends
// the browser there. Keeping this server-side means the client ID never needs to be
// written into the app's own front-end code.

export default async function handler(req, res) {
  const CLIENT_ID = process.env.SAGE_CLIENT_ID;
  if (!CLIENT_ID) {
    return res.status(500).send("Sage isn't configured yet — SAGE_CLIENT_ID is missing from Vercel's environment variables.");
  }
  const APP_URL = `https://${req.headers.host}`;
  const redirectUri = `${APP_URL}/api/sage-callback`;
  const state = Math.random().toString(36).slice(2);

  const authUrl = `https://www.sageone.com/oauth2/auth/central` +
    `?filter=apiv3.1` +
    `&response_type=code` +
    `&client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=full_access` +
    `&state=${state}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
}
