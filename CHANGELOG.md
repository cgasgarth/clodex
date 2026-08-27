# Changelog

## [3.1.0](https://github.com/cgasgarth/clodex/compare/v3.0.0...v3.1.0) (2026-08-13)


### Features

* add SuperGrok OAuth provider with Grok 4.6 ([d8a5116](https://github.com/cgasgarth/clodex/commit/d8a51161ba5a9aeb1b00468adef8568f1fc1375c))
* price Grok usage at API-equivalent rates ([40e02d0](https://github.com/cgasgarth/clodex/commit/40e02d0cbdab05517f0185dbb5a3b91666f731db))
* price Grok usage at API-equivalent rates ([b382167](https://github.com/cgasgarth/clodex/commit/b382167ad84b0825d25744b510be77d94a46568a))
* stream Grok reasoning and cap trace logs ([7572fe7](https://github.com/cgasgarth/clodex/commit/7572fe79f0afff8107b3781736a3d29290ebb3ac))
* unify subscription account management ([#76](https://github.com/cgasgarth/clodex/issues/76)) ([542509d](https://github.com/cgasgarth/clodex/commit/542509d4622998e46201a72946f110409d8c87e8))


### Bug Fixes

* recover from repetitive Grok output ([8a74b79](https://github.com/cgasgarth/clodex/commit/8a74b7986a2267c0508f2a2a41feda08283aa7e0))
* refresh managed SuperGrok OAuth tokens ([0d10b71](https://github.com/cgasgarth/clodex/commit/0d10b71ee28c2414d7e7bf815b8598da160b581f))
* support native web search through Claude ([#73](https://github.com/cgasgarth/clodex/issues/73)) ([446608d](https://github.com/cgasgarth/clodex/commit/446608decada64380fd73eedcc6960dc22c8ef94))

## [3.0.0](https://github.com/cgasgarth/clodex/compare/v2.1.6...v3.0.0) (2026-08-12)


### ⚠ BREAKING CHANGES

* **runtime:** migrate clodex to Bun

### Features

* add account-scoped usage and cost dashboard ([dee7431](https://github.com/cgasgarth/clodex/commit/dee7431e606407b53c5f3ab9cdcb02f4c89d23e6))
* add account-scoped usage and cost dashboard ([c277e63](https://github.com/cgasgarth/clodex/commit/c277e6389884ca596c1a6398a45b0b4e0d2ecce8))
* add daemon-wide Secondwind controls ([0ffc838](https://github.com/cgasgarth/clodex/commit/0ffc83880e1bb399b5b9b11d971184d85d353480))
* add persistent daemon and native compact bridge ([63134c1](https://github.com/cgasgarth/clodex/commit/63134c1ada027ae697f770e7bc59480b48bd4b46))
* add persistent daemon and native compact bridge ([22430b8](https://github.com/cgasgarth/clodex/commit/22430b8c6bfc2cdc651d828776ae509f65164e39))
* add safe dashboard configuration ([174e1eb](https://github.com/cgasgarth/clodex/commit/174e1ebcc0c1110a68154e242f7aa77b6401d30d))
* **dashboard:** toggle usage account scope ([#61](https://github.com/cgasgarth/clodex/issues/61)) ([e74ab69](https://github.com/cgasgarth/clodex/commit/e74ab69356bcfca4160afb891f5d955450f588b5))
* let native compaction own OpenAI context lifecycle ([f19fba2](https://github.com/cgasgarth/clodex/commit/f19fba21bd0762d09f24e2d4e73d6f1c1b43c78f))
* **models:** add Spark OAuth fallback ([00ed045](https://github.com/cgasgarth/clodex/commit/00ed045a52cfedab9900bf26640d5bfbdaa5cff9))
* persist cache-aware Secondwind savings metrics ([04475df](https://github.com/cgasgarth/clodex/commit/04475df6ca486b8108767d977204a78d00542864))
* persist Secondwind savings metrics ([a708bfe](https://github.com/cgasgarth/clodex/commit/a708bfe1f87b0302b5e8899c5b51cd4ad38823db))
* **runtime:** migrate Clodex completely to Bun ([0e42d03](https://github.com/cgasgarth/clodex/commit/0e42d03dfba65fe9a48c77c5bd889b8328502d57))
* **runtime:** migrate clodex to Bun ([70b2eef](https://github.com/cgasgarth/clodex/commit/70b2eefcf6b4167dac22b90c807a031f5b699e86))
* show detailed compaction diagnostics ([#64](https://github.com/cgasgarth/clodex/issues/64)) ([68bdce4](https://github.com/cgasgarth/clodex/commit/68bdce4bc75a13017cd52436900912a6b0f8b3be))
* support Claude Code 2.1.224 ([#65](https://github.com/cgasgarth/clodex/issues/65)) ([fb5ce39](https://github.com/cgasgarth/clodex/commit/fb5ce39e92a9bd68ed118797fb2695bb979dc6be))
* use rolling dashboard usage ranges ([#52](https://github.com/cgasgarth/clodex/issues/52)) ([91d47d0](https://github.com/cgasgarth/clodex/commit/91d47d04d90de04dfe8c25f308f15f73231035d8))


### Bug Fixes

* align steering and streaming reliability ([#68](https://github.com/cgasgarth/clodex/issues/68)) ([301be8f](https://github.com/cgasgarth/clodex/commit/301be8fb335c131c1a133f2a1e6a9f7d39a5ad0f))
* bound daemon native memory ([#57](https://github.com/cgasgarth/clodex/issues/57)) ([7cc75bc](https://github.com/cgasgarth/clodex/commit/7cc75bcbc04ec947200356a98c0b9d21b9972aca))
* clarify dashboard view keys ([6f359de](https://github.com/cgasgarth/clodex/commit/6f359de3231054b54bfe8a551e0083919415d1a1))
* clarify dashboard view keys ([afbf0ea](https://github.com/cgasgarth/clodex/commit/afbf0ea88cceba8a4886cf69823dd7c1ac68c139))
* classify interrupted stream recovery ([#42](https://github.com/cgasgarth/clodex/issues/42)) ([a0978d5](https://github.com/cgasgarth/clodex/commit/a0978d5d69f4655d8dbb8e7a02d86da526c601b0))
* **compaction:** cap thresholds by model window ([eed173c](https://github.com/cgasgarth/clodex/commit/eed173c3367560f84354f1156de3d0080b2a18fb))
* **compaction:** harden durable agent recovery ([16a95c5](https://github.com/cgasgarth/clodex/commit/16a95c51d8f0ed884edccbc029252372e29df8f3))
* **compaction:** preserve recovered live heads ([292c9fc](https://github.com/cgasgarth/clodex/commit/292c9fc913bd810b517225b10ee43cb8c2f6f770))
* **compaction:** recover agent sessions across restarts ([8391d3f](https://github.com/cgasgarth/clodex/commit/8391d3f94c9caa3dbae1c29b706ae4cac8ab6019))
* **compaction:** recover oversized tool turns ([5b59125](https://github.com/cgasgarth/clodex/commit/5b5912576de3d770234cbccf72378cb83182f92e))
* **compaction:** recover oversized tool turns ([575c26a](https://github.com/cgasgarth/clodex/commit/575c26ada3adb905eb8853a1b4ad38ba268f5e88))
* handle interrupted streams safely ([2577f27](https://github.com/cgasgarth/clodex/commit/2577f27a3bef1f4255b96017c253b28d05e8a0b0))
* improve mid-turn steering and support Claude 2.1.227 ([#66](https://github.com/cgasgarth/clodex/issues/66)) ([2d5e2ca](https://github.com/cgasgarth/clodex/commit/2d5e2ca2e95189c407ed62233cbdf1e6a9248edf))
* invalidate stale Claude timeout patches ([a1da28f](https://github.com/cgasgarth/clodex/commit/a1da28fafa23e0bb035efa418670d8443e9af9f4))
* invalidate stale Claude timeout patches ([c01411c](https://github.com/cgasgarth/clodex/commit/c01411cd77a9c0978d452afc308246f65d16433d))
* isolate daemon control plane ([#49](https://github.com/cgasgarth/clodex/issues/49)) ([e4b5e27](https://github.com/cgasgarth/clodex/commit/e4b5e27f33c20097f927442a426444026f78b71d))
* keep daemon API key approval stable ([dcc9c33](https://github.com/cgasgarth/clodex/commit/dcc9c33e1a658ec7d879ef7dac6f2541b072f748))
* keep dashboard available during panel timeouts ([1932353](https://github.com/cgasgarth/clodex/commit/193235383b72251b6d366c634546ef88e930a4d2))
* keep dashboard available during panel timeouts ([8fb7ac1](https://github.com/cgasgarth/clodex/commit/8fb7ac14bae916addef723f7204faed98de28e4f))
* keep dashboard device code visible ([85be7f7](https://github.com/cgasgarth/clodex/commit/85be7f7721734e571fb63ae5657c4b785f300e2f))
* keep dashboard device code visible ([e428ef4](https://github.com/cgasgarth/clodex/commit/e428ef488d3efd28f1199a1a29760523a5c833f5))
* keep transient MCP state out of replay history ([#63](https://github.com/cgasgarth/clodex/issues/63)) ([ef60868](https://github.com/cgasgarth/clodex/commit/ef6086894e0ea0407903931fb0ada3c9d5736501))
* make local global installs repeatable ([#50](https://github.com/cgasgarth/clodex/issues/50)) ([d0e494c](https://github.com/cgasgarth/clodex/commit/d0e494c11d12ecb30d85d38f843f57c4ff2ad763))
* make long operations timeout tolerant ([9a4c411](https://github.com/cgasgarth/clodex/commit/9a4c4114af5ecc5afe0e6a5e89648c6d169561e3))
* make mid-turn steering reliable ([#67](https://github.com/cgasgarth/clodex/issues/67)) ([9a7a3e4](https://github.com/cgasgarth/clodex/commit/9a7a3e4bee607c35f6d1f3c494821beadf28745c))
* make Secondwind savings auditable ([885e2a6](https://github.com/cgasgarth/clodex/commit/885e2a67e655e9514cef34e0d33ac5d7464c899b))
* **oauth:** restore compact checkpoints after transcript replay ([#60](https://github.com/cgasgarth/clodex/issues/60)) ([b3f209a](https://github.com/cgasgarth/clodex/commit/b3f209a4bf20586fa0fff4e702adb00608774539))
* **oauth:** surface in-band request rejections instead of an empty 200 ([#67](https://github.com/cgasgarth/clodex/issues/67)) ([53a83ba](https://github.com/cgasgarth/clodex/commit/53a83baade59a01c74ee1ad073831c366f25872b))
* preserve compact anchors across account handoffs ([#62](https://github.com/cgasgarth/clodex/issues/62)) ([527827e](https://github.com/cgasgarth/clodex/commit/527827edb47e2475bb3fb4fbf76544f383f35eb2))
* preserve transient steering priority ([#69](https://github.com/cgasgarth/clodex/issues/69)) ([f7c1c63](https://github.com/cgasgarth/clodex/commit/f7c1c6393201f24bfd49743168fb9a59c2faa81d))
* **reasoning:** suppress reasoning.summary for gpt-5.3-codex-spark ([#65](https://github.com/cgasgarth/clodex/issues/65)) ([2a65c6b](https://github.com/cgasgarth/clodex/commit/2a65c6b8df164c704cb4cd6e3dc52a95e4d5e52a))
* recover provider message and status from mid-stream error frames ([#68](https://github.com/cgasgarth/clodex/issues/68)) ([6934585](https://github.com/cgasgarth/clodex/commit/6934585f828b3fb46fd3bc99cdb2782869aafbab))
* relax daemon and model idle timeouts ([e0c057f](https://github.com/cgasgarth/clodex/commit/e0c057fd2544a2b6d6d83bf64d0bdc53b25d94ba))
* relax daemon and model idle timeouts ([cd26fb0](https://github.com/cgasgarth/clodex/commit/cd26fb061d3d17a9588ef8df3630a9bb6a6d1807))
* **release:** use valid fork bootstrap ([#72](https://github.com/cgasgarth/clodex/issues/72)) ([cfdf168](https://github.com/cgasgarth/clodex/commit/cfdf16811d429217bfd314d4f7dea1509724b868))
* report measured Secondwind token savings ([0a96a85](https://github.com/cgasgarth/clodex/commit/0a96a85785d19c5d7fb865090fbfc1e891e2e1cd))
* restore compacted resumes without idle disconnects ([#51](https://github.com/cgasgarth/clodex/issues/51)) ([454bfa1](https://github.com/cgasgarth/clodex/commit/454bfa10626574f3a5c46abcf29b0fabfe8e9b57))
* retry buffered child-agent streams ([#44](https://github.com/cgasgarth/clodex/issues/44)) ([e5a1b71](https://github.com/cgasgarth/clodex/commit/e5a1b7132b9d4a789f9cebeca651094afc897191))
* route background Claude requests ([#56](https://github.com/cgasgarth/clodex/issues/56)) ([62d8edd](https://github.com/cgasgarth/clodex/commit/62d8edd1e6188e822a0d24e7c40b32a330649196))
* scope Secondwind savings percentage ([a57479e](https://github.com/cgasgarth/clodex/commit/a57479e6a847f2c97b0d9c19c1aaae1f929a7d12))
* update Luna and Terra API pricing ([e43770a](https://github.com/cgasgarth/clodex/commit/e43770a0f96591b77c30e4275f8ed46c57f4e1f9))


### Performance Improvements

* aggregate daemon metrics writes ([ee87704](https://github.com/cgasgarth/clodex/commit/ee87704b10f5d2d16dfb1eb4ab45b2c22d70a13b))
* **oauth:** cache canonical conversation items ([#59](https://github.com/cgasgarth/clodex/issues/59)) ([8141c99](https://github.com/cgasgarth/clodex/commit/8141c9923243fd3964f5f666f49da2700c5a62f0))
* randomly schedule Secondwind rewrites ([#53](https://github.com/cgasgarth/clodex/issues/53)) ([79a63ad](https://github.com/cgasgarth/clodex/commit/79a63ad5e66b3af5fa7ed26768a757af1743369f))
* reduce Secondwind and logging overhead ([#54](https://github.com/cgasgarth/clodex/issues/54)) ([b67b5b0](https://github.com/cgasgarth/clodex/commit/b67b5b0fac052ab73dfbe2d3dc7f85abab43eaee))
* **secondwind:** reuse conversation sessions ([#58](https://github.com/cgasgarth/clodex/issues/58)) ([d530f45](https://github.com/cgasgarth/clodex/commit/d530f459ab870a26de7cc9f5cc6eaca1ec700f6a))

## [2.1.6](https://github.com/cgasgarth/clodex/compare/v2.1.5...v2.1.6) (2026-07-29)


### Bug Fixes

* **oauth:** surface in-band request rejections instead of an empty 200 ([#67](https://github.com/cgasgarth/clodex/issues/67)) ([d512065](https://github.com/cgasgarth/clodex/commit/d5120656f9c80518f150bbf3193eb781f27d6df9))
* **reasoning:** suppress reasoning.summary for gpt-5.3-codex-spark ([#65](https://github.com/cgasgarth/clodex/issues/65)) ([b455916](https://github.com/cgasgarth/clodex/commit/b455916d117398ba0635f551180f899ec5a660be))
* recover provider message and status from mid-stream error frames ([#68](https://github.com/cgasgarth/clodex/issues/68)) ([5b138e4](https://github.com/cgasgarth/clodex/commit/5b138e4bf9390c610b578a294e697216f2bb8d49))

## [2.1.5](https://github.com/cgasgarth/clodex/compare/v2.1.4...v2.1.5) (2026-07-27)


### Bug Fixes

* canonicalize aliases without unsafe fallback ([#59](https://github.com/cgasgarth/clodex/issues/59)) ([5fec19a](https://github.com/cgasgarth/clodex/commit/5fec19a1c399491259e25b5b34cf447f95fbd08d))
* **patcher:** include transform-set version in patch config hash ([#60](https://github.com/cgasgarth/clodex/issues/60)) ([09f79ad](https://github.com/cgasgarth/clodex/commit/09f79ad968dbd5b3d53c8b4d9a43b3d2cbe1011d))
* **patcher:** resolve claude version from the binary being patched ([#62](https://github.com/cgasgarth/clodex/issues/62)) ([164be9d](https://github.com/cgasgarth/clodex/commit/164be9d2ef99f4cd81473ebdf3a42818f2994cc2))
* preserve extended effort levels in patched clients ([#57](https://github.com/cgasgarth/clodex/issues/57)) ([e61f972](https://github.com/cgasgarth/clodex/commit/e61f9725d14784fffebf26add13c3cc6fa1945ec))

## [2.1.4](https://github.com/cgasgarth/clodex/compare/v2.1.3...v2.1.4) (2026-07-27)


### Bug Fixes

* **adapter:** prevent cached input usage inflation ([#56](https://github.com/cgasgarth/clodex/issues/56)) ([4d96f54](https://github.com/cgasgarth/clodex/commit/4d96f5462c793fcf9e1677d07aedc8fe2cc954bd))
* **proxy:** reuse private adapter connections ([#54](https://github.com/cgasgarth/clodex/issues/54)) ([6de7af9](https://github.com/cgasgarth/clodex/commit/6de7af96b957630dc2a4ea1fc7cfdd7481501685))

## [2.1.3](https://github.com/cgasgarth/clodex/compare/v2.1.2...v2.1.3) (2026-07-25)


### Bug Fixes

* **wrapper:** exec into claude so background pty resizes reach it ([#51](https://github.com/cgasgarth/clodex/issues/51)) ([73661d6](https://github.com/cgasgarth/clodex/commit/73661d672cdbc2d2f2ccdc1b808a3b80d4811338))

## [2.1.2](https://github.com/cgasgarth/clodex/compare/v2.1.1...v2.1.2) (2026-07-25)


### Bug Fixes

* **auth:** make chunked credentials crash-safe ([#17](https://github.com/cgasgarth/clodex/issues/17)) ([cae6db6](https://github.com/cgasgarth/clodex/commit/cae6db6389bcae576ccc51f054937dfe4685b059))
* **wrapper:** retry transient listener checks ([#44](https://github.com/cgasgarth/clodex/issues/44)) ([de233d8](https://github.com/cgasgarth/clodex/commit/de233d8c00aa12c55405ad12b9e9740988e8ee38))

## [2.1.1](https://github.com/cgasgarth/clodex/compare/v2.1.0...v2.1.1) (2026-07-24)


### Bug Fixes

* **logging:** attribute proxy transport failures ([#43](https://github.com/cgasgarth/clodex/issues/43)) ([5bff8dd](https://github.com/cgasgarth/clodex/commit/5bff8ddb05c1fbd15760ea51791f71ac8eb94a77))

## [2.1.0](https://github.com/cgasgarth/clodex/compare/v2.0.0...v2.1.0) (2026-07-24)


### Features

* **logging:** correlate response lifecycles ([#26](https://github.com/cgasgarth/clodex/issues/26)) ([2de8cf8](https://github.com/cgasgarth/clodex/commit/2de8cf8393f1f4bba867a05a0f22cec03acd6597))


### Bug Fixes

* **routing:** prevent configured route bypasses ([#10](https://github.com/cgasgarth/clodex/issues/10)) ([383f464](https://github.com/cgasgarth/clodex/commit/383f46461ddea28ee42e63bf6c52b1507f4ab4c5))

## [2.0.0](https://github.com/cgasgarth/clodex/compare/v1.3.0...v2.0.0) (2026-07-24)


### ⚠ BREAKING CHANGES

* remove legacy ~/.relay-ai migration support ([#37](https://github.com/cgasgarth/clodex/issues/37))

### Features

* remove legacy ~/.relay-ai migration support ([#37](https://github.com/cgasgarth/clodex/issues/37)) ([6a7b5cf](https://github.com/cgasgarth/clodex/commit/6a7b5cf35552b042a5b7b1b555be7c4eb51ec7d8))


### Bug Fixes

* **config:** serialize and atomically write preferences ([#40](https://github.com/cgasgarth/clodex/issues/40)) ([e653d89](https://github.com/cgasgarth/clodex/commit/e653d8939ce3244e50d65f0993579df156b02afd))
* **oauth:** treat websocket_connection_limit_reached as a retryable limit ([#38](https://github.com/cgasgarth/clodex/issues/38)) ([32c1f7b](https://github.com/cgasgarth/clodex/commit/32c1f7b552a20869e0a08ba79de09b5c1a1e1143))
* **providers:** reconcile credential cleanup for interactive hub mutations ([#39](https://github.com/cgasgarth/clodex/issues/39)) ([102e496](https://github.com/cgasgarth/clodex/commit/102e496a4b7c11430f4c215ccc9b218d19e5f020))
* **trace:** redact resolved credentials from trace logs by value ([#35](https://github.com/cgasgarth/clodex/issues/35)) ([46d4818](https://github.com/cgasgarth/clodex/commit/46d4818afdd9285c5beec66e31dc39089b1f61f0))

## [1.3.0](https://github.com/cgasgarth/clodex/compare/v1.2.2...v1.3.0) (2026-07-24)


### Features

* **logging:** record proxy process lifecycle ([#30](https://github.com/cgasgarth/clodex/issues/30)) ([495684c](https://github.com/cgasgarth/clodex/commit/495684c63544c8d7b74ece0041585554157de427))


### Bug Fixes

* **auth:** make credential cleanup crash-safe ([#15](https://github.com/cgasgarth/clodex/issues/15)) ([9657038](https://github.com/cgasgarth/clodex/commit/96570383c82d0e92298909c1b6c75a28820335dd))
* **auth:** recover once from rejected access tokens ([#16](https://github.com/cgasgarth/clodex/issues/16)) ([f9272d6](https://github.com/cgasgarth/clodex/commit/f9272d60adafdf904f97ddae06f910bfd93b706b))
* **oauth:** map upstream 403 throttle to retryable 429 ([#33](https://github.com/cgasgarth/clodex/issues/33)) ([303db6e](https://github.com/cgasgarth/clodex/commit/303db6eb8bffd15004c0b69105cfe3cf95e22572))
* **transport:** retry pre-frame websocket failures ([#29](https://github.com/cgasgarth/clodex/issues/29)) ([8485e1c](https://github.com/cgasgarth/clodex/commit/8485e1c757cf8c23d9ceaa215977871dacda191b))

## [1.2.2](https://github.com/cgasgarth/clodex/compare/v1.2.1...v1.2.2) (2026-07-23)


### Bug Fixes

* **auth:** enforce anonymous credential boundaries ([#21](https://github.com/cgasgarth/clodex/issues/21)) ([d4ec9e2](https://github.com/cgasgarth/clodex/commit/d4ec9e2b02f5203efad77eb21cf735c13feab8a0))
* **server:** wait for listener readiness ([#23](https://github.com/cgasgarth/clodex/issues/23)) ([77ae2bf](https://github.com/cgasgarth/clodex/commit/77ae2bf57e92dce4adb61efe4be3b79323b060d8))

## [1.2.1](https://github.com/cgasgarth/clodex/compare/v1.2.0...v1.2.1) (2026-07-23)


### Bug Fixes

* **patcher:** pin node-gyp-build directly to unbreak fresh installs ([94aeab8](https://github.com/cgasgarth/clodex/commit/94aeab8910d93da8dc3fa1dd0402b24b1faa3601))

## [1.2.0](https://github.com/cgasgarth/clodex/compare/v1.1.0...v1.2.0) (2026-07-22)


### Features

* **auth:** harden credential and registry handling ([#8](https://github.com/cgasgarth/clodex/issues/8)) ([502450c](https://github.com/cgasgarth/clodex/commit/502450c42c4a6359307853a86dd5a33ed0aa5980))


### Bug Fixes

* **adapter:** deliver tool_result images as vision parts instead of base64 text ([#22](https://github.com/cgasgarth/clodex/issues/22)) ([ac48a3b](https://github.com/cgasgarth/clodex/commit/ac48a3b50ed8a6e58f6433ec8a64ba939036b776))

## [1.1.0](https://github.com/cgasgarth/clodex/compare/v1.0.4...v1.1.0) (2026-07-21)


### Features

* **wrapper:** add opt-in readiness enforcement ([#12](https://github.com/cgasgarth/clodex/issues/12)) ([e590981](https://github.com/cgasgarth/clodex/commit/e5909812cfef7110c800aa39e1cf037df403815a))


### Bug Fixes

* **transport:** isolate connections by credential ([#9](https://github.com/cgasgarth/clodex/issues/9)) ([b770db6](https://github.com/cgasgarth/clodex/commit/b770db6fb6f406a0b18919e8e297c123ed612526))
* **transport:** terminate rejected connection upgrades ([#11](https://github.com/cgasgarth/clodex/issues/11)) ([904b077](https://github.com/cgasgarth/clodex/commit/904b07731c6440c6f9c81daa7ac6d3d67e41061e))

## [1.0.4](https://github.com/cgasgarth/clodex/compare/v1.0.3...v1.0.4) (2026-07-20)


### Bug Fixes

* **proxy:** keepalive pings while buffering tool-call args to survive client idle abort ([ede161e](https://github.com/cgasgarth/clodex/commit/ede161e9ecbb9e11a01c713bdd5ceafd51203ebf))

## [1.0.3](https://github.com/cgasgarth/clodex/compare/v1.0.2...v1.0.3) (2026-07-20)


### Bug Fixes

* **adapter:** strip null/empty-array filler from optional tool params ([105dde5](https://github.com/cgasgarth/clodex/commit/105dde5ef6b62e72bdddaffcf2109fa1ab13c1ab))

## [1.0.2](https://github.com/cgasgarth/clodex/compare/v1.0.1...v1.0.2) (2026-07-20)


### Bug Fixes

* **test:** wait for terminal log event in http-proxy passthrough test to fix CI flake ([b683631](https://github.com/cgasgarth/clodex/commit/b68363166b92a805f468760bec4a92d215122829))

## [1.0.1](https://github.com/cgasgarth/clodex/compare/v1.0.0...v1.0.1) (2026-07-20)


### Bug Fixes

* **patcher:** replace unpinned npx tweakcc with pinned programmatic API ([bfb626f](https://github.com/cgasgarth/clodex/commit/bfb626fd0afeeeec4e6715d2fd9a8fd85cb4ae5f))

## [1.0.0](https://github.com/cgasgarth/clodex/compare/v0.1.1...v1.0.0) (2026-07-20)


### Documentation

* refine README wording and add proxy/agents tips ([614ea7d](https://github.com/cgasgarth/clodex/commit/614ea7d7daf7e0a58eaa5c7341ad5e42c86751ef))

## [0.1.1](https://github.com/cgasgarth/clodex/compare/v0.1.0...v0.1.1) (2026-07-20)


### Features

* **patch:** make short aliases the model identity and use real model labels ([1eda5f1](https://github.com/cgasgarth/clodex/commit/1eda5f17468b9d71018c39e30f309f12e9faa444))
* **server:** multi-server discovery, --no-discovery opt-out, endpoint alias resolution ([cfe91f5](https://github.com/cgasgarth/clodex/commit/cfe91f5ed08af0ebc36d150e2d8d67d44309d549))

## [0.1.0] - 2026-07-19

Initial release of **clodex**, built to bridge Claude Code to OpenAI models
through an OpenAI API key or ChatGPT/Codex-plan OAuth.

### Core features

- Anthropic ↔ OpenAI translation through the Vercel AI SDK adapter, including prompt-cache breakpoint mapping and cache-token accounting.
- ChatGPT/Codex OAuth Responses WebSocket continuation (`previous_response_id` incremental input with exact-prefix chain heads and safe full-context fallback).
- Endpoint bridge mode (local Anthropic-format gateway + `ANTHROPIC_BASE_URL`) with the multi-route favorites switch menu.
- Proxy bridge mode (selective `api.anthropic.com` MITM) with the alias response-model echo that keeps Claude Code's auto-compaction working.
- Favorites/alias management (`clodex models`) and the foreground gateway (`clodex server`, endpoint + proxy modes, `--port`).

### Clodex features

- Rebrand: `clodex` binary/package, `~/.clodex` config home (`CLODEX_HOME` override), `clodex:` model-id prefix, `clodex` keychain service — with silent one-time migration from legacy `~/.relay-ai` config and `relay-ai` keychain entries (legacy data is never modified).
- `clodex patch` — first-class Claude Code binary patcher built on tweakcc: bakes favorites + aliases into the binary (model validation, `/model` listing, alias resolution, real context windows), with a pristine per-version backup, a staleness manifest, a concurrency lock, and `--restore`.
- Launch-time patch freshness check in `clodex claude` (interactive y/N offer; non-blocking notice when non-interactive).
- Per-command bridge-mode defaults: `--endpoint`/`--proxy` select the mode for one run; `--save-mode` persists it as that command's default; bare runs default to proxy mode.
