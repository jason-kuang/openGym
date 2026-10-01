// Hermetic stand-ins for the API server's push/passkey modules, used only by
// the sync protocol test. /api/data never calls these; any accidental call
// throws loudly instead of silently succeeding.
const unreachable = name => () => {
  throw new Error(`syncServerStubs: ${name} must not run in protocol tests`);
};

export const generateRegistrationOptions = unreachable('generateRegistrationOptions');
export const verifyRegistrationResponse = unreachable('verifyRegistrationResponse');
export const generateAuthenticationOptions = unreachable('generateAuthenticationOptions');
export const verifyAuthenticationResponse = unreachable('verifyAuthenticationResponse');

const webpush = {
  generateVAPIDKeys: () => ({ publicKey: 'stub-public', privateKey: 'stub-private' }),
  setVapidDetails: () => {},
  sendNotification: unreachable('sendNotification'),
};

export default webpush;
