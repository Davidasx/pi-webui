import { buildApiKeyProviderList, buildOAuthProviderList } from "../../../../lib/provider-listing.js";
import { collectProviderListingInputs } from "../../../../lib/provider-listing-runtime.js";
import { createModelRuntimeWithExtensions } from "../../../../lib/model-runtime.js";

export const dynamic = "force-dynamic";

// Providers that declare an OAuth login method, including anthropic
// (Claude Pro/Max) — see lib/provider-listing.ts (#309).
export async function GET() {
  const modelRuntime = await createModelRuntimeWithExtensions();
  const inputs = await collectProviderListingInputs(modelRuntime);
  const oauthProviders = buildOAuthProviderList(inputs);
  const apiKeyProviders = buildApiKeyProviderList(inputs);
  return Response.json({ providers: oauthProviders, oauthProviders, apiKeyProviders });
}
