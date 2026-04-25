import { GoogleOauthClient } from "./google-oauth.client";
import { GoogleOauthFactory } from "./google-oauth.factory";

export class GoogleOauthClientFactory {
  static create(): GoogleOauthClient {
    const config = GoogleOauthFactory.createConfig();
    return new GoogleOauthClient(config);
  }
}
