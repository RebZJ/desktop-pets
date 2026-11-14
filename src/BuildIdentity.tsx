import { useEffect, useState } from 'react';
import { api, isNative } from './api';
import './build-identity.css';

export type BuildIdentity = {
  channel: 'dev' | 'installed' | 'preview';
  revision: string;
  dirty: boolean;
  version: string;
  globalShortcutsEnabled: boolean;
};

export function useBuildIdentity() {
  const [identity, setIdentity] = useState<BuildIdentity>({
    channel: isNative() ? import.meta.env.DEV ? 'dev' : 'installed' : 'preview',
    revision: 'checking', dirty: false, version: '0.1.0', globalShortcutsEnabled: false,
  });
  useEffect(() => {
    if (!isNative()) return;
    let current = true;
    void api<BuildIdentity>('build.identity').then(value => { if (current) setIdentity(value); })
      .catch(() => { if (current) setIdentity(value => ({ ...value, revision: 'unknown' })); });
    return () => { current = false; };
  }, []);
  return identity;
}

export function BuildLabel({ identity, overlay = false }: { identity: BuildIdentity; overlay?: boolean }) {
  const channel = identity.channel === 'dev' ? 'DEV' : identity.channel === 'installed' ? 'INSTALLED' : 'WEB PREVIEW';
  return <span className={`build-label${overlay ? ' build-label-overlay' : ''}`} data-channel={identity.channel}
    title={`v${identity.version} · ${identity.revision}${identity.dirty ? ' · local changes' : ''}`}
    aria-label={`${channel} build ${identity.revision}${identity.dirty ? ', local changes' : ''}`}>
    {channel}{identity.channel !== 'preview' && <> · {identity.revision}{identity.dirty ? '+' : ''}</>}
  </span>;
}
