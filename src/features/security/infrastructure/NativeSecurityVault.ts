import type { SecurityVault } from '../domain/types';
import { base64ToBytes } from '../../mesh/domain/wire';

interface NativeVaultModule {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  randomBytes(length: number): Promise<string>;
}

/** Inject NativeModules.PalMeshSecurity at the composition boundary. Missing
 * native support is an error, including on platforms without a host yet. */
export class NativeSecurityVault implements SecurityVault {
  constructor(private readonly native: NativeVaultModule | undefined) {
    if (!native || typeof native.read !== 'function' || typeof native.write !== 'function'
      || typeof native.randomBytes !== 'function') throw new Error('Secure native key storage is unavailable.');
  }

  read(key: string): Promise<string | null> { return this.native!.read(key); }
  write(key: string, value: string): Promise<void> { return this.native!.write(key, value); }
  async randomBytes(length: number): Promise<Uint8Array> {
    const bytes = base64ToBytes(await this.native!.randomBytes(length), length);
    if (bytes.length !== length) throw new Error('Native CSPRNG returned an incorrect byte count.');
    return bytes;
  }
}
