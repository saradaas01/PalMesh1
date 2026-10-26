# Automated native APK alignment verification

The shared APK verifier now parses every packaged native library's ELF program
table and requires power-of-two LOAD alignment of at least 16 KiB, file/virtual
address congruence, valid file/memory segment bounds and a bounded program table.
It handles ELF32/ELF64 and both byte orders. Missing/truncated/invalid ELF and
4 KiB libraries fail even if ZIP page alignment would pass. JSON evidence lists
each native library's minimum LOAD alignment. Existing signing, CRC, ABI,
launcher, Hermes presence and debug/release gates remain in place.

All 37 Android Python tests pass, including new malformed ELF, ELF32/64,
endianness, bounds, no-LOAD and ZIP-versus-ELF regressions. Strict TypeScript and
module build passed. The earlier locally retained ARM64 APK passed the new
verifier for all 14 libraries; this is validation of that earlier binary, not a
claim of a fresh final build. Final integration still needs a new bundled APK.
Static checks do not establish runtime behavior on a physical 16 KiB device.
