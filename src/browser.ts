import {spawn} from 'node:child_process';
import {platform} from 'node:os';

export function validateLoopbackPreviewUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:') {
    throw new Error('Preview URL must use http:');
  }
  if (!['127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('Preview URL must target a loopback host');
  }
  if (!url.searchParams.get('token')) {
    throw new Error('Preview URL must include an authentication token');
  }
  return url;
}

export async function openLoopbackPreviewBrowser(launchUrl: string): Promise<void> {
  const url = validateLoopbackPreviewUrl(launchUrl);
  const currentPlatform = platform();
  const command =
    currentPlatform === 'darwin' ? 'open' :
    currentPlatform === 'win32' ? 'rundll32' :
    'xdg-open';
  const args = currentPlatform === 'win32' ? ['url.dll,FileProtocolHandler', url.toString()] : [url.toString()];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
