import { GoogleOauthConfig, OAUTH_PROVIDER } from "./google-oauth.config";

export class GoogleOauthFactory {
  static createConfig(): GoogleOauthConfig {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
    const redirectUri =
      process.env.GOOGLE_OAUTH_REDIRECT_URI ||
      "http://localhost:4000/auth/oauth/google/callback";

    return {
      provider: OAUTH_PROVIDER.GOOGLE,
      clientId,
      clientSecret,
      redirectUri,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      userInfoEndpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
      scope: ["openid", "email", "profile"],
    };
  }
}
