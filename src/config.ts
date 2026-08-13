// Constants discovered by inspecting Aware's bundles and live session.
// Aware has no public API docs; these were reverse-engineered from the SPA.

/** AWS Cognito user pool that issues Aware's access tokens (federated to Azure AD). */
export const COGNITO_POOL_ID = "us-east-1_lI9I6nBPq";

/** Cognito region, embedded in the pool id but kept explicit for the endpoint URL. */
export const COGNITO_REGION = "us-east-1";

/** Public Cognito app client (no secret) used by Aware's shared help-hub-header. */
export const COGNITO_CLIENT_ID = "50glsptveganstg520vkqrj50m";

/** Cognito IDP endpoint for the InitiateAuth (REFRESH_TOKEN_AUTH) call. */
export const COGNITO_IDP_URL = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;

/**
 * Aware's REST backend (AWS API Gateway). Its /persons/@me and /search endpoints
 * use AWS IAM (SigV4) auth, not the Cognito Bearer token, so the connector does
 * not call them — people data comes from the Bearer-readable CDN feed instead.
 * Kept for reference / a future SigV4 implementation.
 */
export const AWARE_API_BASE = "https://api.adskaware.autodesk.com/api/v1";

/** CloudFront prefix for static org data and headshots. */
export const AWARE_CDN_BASE = "https://cdn.adskaware.autodesk.com";

/** Keychain identifiers for the stored refresh token (macOS `security` generic password). */
export const KEYCHAIN_SERVICE = "aware-connector";
export const KEYCHAIN_ACCOUNT = "cognito-refresh-token";
