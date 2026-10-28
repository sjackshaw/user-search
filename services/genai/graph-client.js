'use strict';

const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

function graphConfigured() {
  return Boolean(
    process.env.ENTRA_TENANT_ID &&
    process.env.ENTRA_CLIENT_ID &&
    process.env.ENTRA_CLIENT_SECRET
  );
}

function createMockGraphClient() {
  return {
    mode: 'mock',
    api(path) {
      return {
        async get() {
          return { '@odata.context': 'mock', value: [], path };
        },
        async post(body) {
          return { '@odata.context': 'mock', path, body, accepted: true };
        },
        async patch(body) {
          return { '@odata.context': 'mock', path, body, accepted: true };
        },
        async delete() {
          return { '@odata.context': 'mock', path, accepted: true };
        },
      };
    },
  };
}

function createGraphClient() {
  if (!graphConfigured()) {
    return createMockGraphClient();
  }

  let ClientSecretCredential;
  let Client;
  let TokenCredentialAuthenticationProvider;

  try {
    ({ ClientSecretCredential } = require('@azure/identity'));
    ({ Client } = require('@microsoft/microsoft-graph-client'));
    ({ TokenCredentialAuthenticationProvider } = require(
      '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials'
    ));
  } catch (err) {
    throw new Error(
      'Microsoft Graph credentials are configured, but Graph client packages are not installed. Run npm install in services/genai. ' +
      err.message,
      { cause: err }
    );
  }

  const credential = new ClientSecretCredential(
    process.env.ENTRA_TENANT_ID,
    process.env.ENTRA_CLIENT_ID,
    process.env.ENTRA_CLIENT_SECRET
  );
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: [GRAPH_SCOPE],
  });

  const client = Client.initWithMiddleware({ authProvider });
  client.mode = 'graph';
  return client;
}

module.exports = createGraphClient();