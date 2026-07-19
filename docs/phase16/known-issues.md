# Phase 16 Known Issues

1. 실제 application DB role 분리는 Phase 17 durable control plane에서 완성한다. 현재 procedure와 table은 `PUBLIC`에서 모두 회수되었지만 DB owner로 실행하는 프로세스는 여전히 강한 권한을 가진다.
2. sandbox container image는 운영자가 사전에 build/pull하고 고정 tag 또는 digest로 제공해야 한다. Phase 16은 image supply-chain signing 자체를 구현하지 않는다.
3. finalizer는 안전한 atomic ref 갱신을 위해 bare canonical repository를 요구한다. 현재 사용자가 `!project`로 지정하는 non-bare working copy에 직접 finalization하지 않는다.
4. 기존 `workspace_locks`는 legacy runtime 호환을 위해 남아 있다. Phase 16 artifact finalization 권한으로 해석하면 안 된다.
5. Git ref 변경과 PostgreSQL transaction은 하나의 원자 transaction이 될 수 없다. ref 변경 후 DB 장애는 `NEEDS_RECONCILIATION`과 runbook으로 다룬다.
6. Gate 전에는 Coder/QA 실행이 차단된다. `ISOLATED_WORKSPACE_MODE=false`가 canonical direct-write 호환 모드라는 의미가 아니다.
