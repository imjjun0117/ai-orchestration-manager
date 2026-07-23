# Phase 18 Known Issues

1. 기본 semantic signal은 외부 embedding provider가 아니라 64차원 deterministic feature-hash vector입니다. 재현성과 비밀 비전송을 우선하며, 검색 품질은 shadow report로 확인합니다.
2. retrieval concurrency limiter는 역할 프로세스별로 동작합니다. 각 RoleWorker 자체가 한 job씩 실행하고 DB 함수가 candidate를 100개 이하로 제한하므로 현재 6봇 topology에서는 유계이지만, 향후 한 역할을 여러 worker로 수평 확장하면 DB 기반 전역 admission control을 추가해야 합니다.
3. source 삭제 후 과거 manifest의 metadata와 hash는 재현되지만 원문 package는 의도적으로 복원할 수 없습니다. replay는 `sourceItemsAvailable=false`를 반환합니다.
4. `shadow-quality`는 다섯 역할의 실제 Long/Episodic 선택, fallback, token/latency를 평가하지만 LLM 답변의 주관적 품질을 자동 판정하지 않습니다. enforced 전 운영자가 실제 카나리 결과를 함께 확인해야 합니다.
5. source ingestion JSON에는 원문이 들어가므로 Git 추적 경로나 공유 디렉터리에 두지 않고 `0600` 보호 경로를 사용해야 합니다.
6. ingestion, source/index deletion, rebuild는 provenance 및 conflict 상태의 경쟁을 막기 위해 DB 단위 advisory lock으로 직렬화됩니다. 검색 경로는 이 잠금을 사용하지 않습니다.
7. 애플리케이션 timeout은 즉시 legacy prompt로 fallback하지만 이미 시작된 PostgreSQL query를 서버에서 취소하지는 않습니다. 프로세스별 동시성 2와 queue 8로 점유를 제한하며, 수평 확장 전에는 취소 가능한 query client와 timeout 부하 검증이 필요합니다.
