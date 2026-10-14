# FAB-SIM — 반도체 설비 통합 UI · 테스트 시뮬레이터

> **테스트 전용 시뮬레이션 프로그램입니다.** 실제 설비에 연결하지 않으며, 모든
> 제조사·모델 이름은 가상입니다.

제조사마다 다른 설비 UI를 **하나의 설비 UI**로 대체하는 개념을 시험하는
응용프로그램입니다. 설비가 만드는 **Trace(실시간 센서 데이터)** 와 **ERD(이벤트
리포트 데이터)** 를 사용자 설정에 따라 생성합니다. 이 데이터는 메시지 버스를 거쳐
함께 구현된 **EES · FDC · QMS · AMS** 네 시스템으로 전달됩니다.

설치 없이 써 보려면 단일 파일판 `fab-sim.html` 을 브라우저(맥·윈도우 모두)로 열면
됩니다. 시뮬레이션이 브라우저 안에서 돌고, 시나리오는 브라우저 저장소에 남습니다.
파일은 GitHub Actions 실행 결과의 `fab-sim-html` 아티팩트로 받거나 직접 만듭니다.

```sh
npm run build:standalone   # dist/fab-sim.html (서버 불필요, 파일 하나)
```

서버로 실행하려면 Node.js 20.19 이상 또는 22.12 이상이 필요합니다.

## 실행

```sh
git clone https://github.com/Yongwon12/fab-sim.git
cd fab-sim
npm ci                 # .npmrc 에 legacy-peer-deps 가 켜져 있습니다
npm run dev            # http://127.0.0.1:4870 (UI 핫 리로드)
```

배포형 실행:

```sh
npm run build          # 타입 검사 + UI 번들 (dist/client)
npm start              # http://127.0.0.1:4870
```

옵션(`npm start -- --port 5000` 처럼 전달):

| 옵션 | 설명 |
|---|---|
| `--port 4870` `--host 127.0.0.1` | 수신 주소 |
| `--data ./data` | 시나리오 저장 폴더 (기본 `data/`, git 제외) |
| `--no-persist` | 저장하지 않음 |
| `--paused` | 시뮬레이션을 정지 상태로 시작 |
| `--seed 1234` | 난수 시드 (같은 시드·설정이면 같은 데이터 재현) |

테스트: `npm test` (단위 + 통합, 33개), 타입 검사: `npm run typecheck`

## 구성

```
 제조사 A  SECS-II/HSMS ─┐
 제조사 B  XML over TCP ──┼─▶ 통합 어댑터 ─▶ 메시지 버스 ─┬─▶ EES  설비 상태·가동 지표
 제조사 C  OPC UA JSON ──┘   (이름·단위·코드    (토픽 구독)   ├─▶ FDC  이상 감지·분류 ──┐
        ▲                     통합 모델로)                    ├─▶ QMS  품질·SPC ────────┤ HOLD
        │                                                     └─▶ AMS  알람 통합 관리   │ (S2F41)
        └──────────────────────── Host 원격 명령 ◀───────────────────────────────────────┘
 단일 설비 UI(설비 콘솔)는 설비 쪽 화면이라 OFFLINE 중에도 데이터를 보여 줍니다.
```

- **설비 시뮬레이터** (`src/server/simulator`): 시뮬레이션 시계(1×–120×), 설비별
  상태기계(SEMI E10 / GEM 제어 상태 / 공정 상태), Carrier·Lot·Wafer 흐름,
  레시피 Step 실행, 1차 지연 응답 + 노이즈 + 챔버 노화 신호, 장비 인터락, 랜덤
  알람, PM, 계측값 생성
- **제조사 계층** (`vendors.ts`): 가상의 제조사 3곳이 같은 데이터를 서로 다른
  이름·단위·번호·형식으로 내보냅니다. 통합 어댑터가 실제로 원본 프레임을 파싱해
  통합 모델로 변환합니다.

  | | VA Axion Semitech | VB Lumen Process | VC Kairo Technologies |
  |---|---|---|---|
  | 형식 | SECS-II (S6F1, S6F11, S5F1, S2F41) | 독자 XML | OPC UA 스타일 JSON |
  | 이름 | `PM1.RfSourcePower` + SVID | `PM1_RF_SOURCE_POWER` | `ns=2;s=ETCH-01/PM1/rfSourcePower` |
  | 단위 | W, mTorr, °C | kW, Pa, K | W, Torr, °F, slm, kPa |
  | 알람 | ALCD/ALID | 16진 코드, 레벨 1–4 | ConditionId, Severity 1–1000 |

- **메시지 버스** (`src/server/bus`): MQTT식 토픽(`eqp/{id}/trace/{chamber}`,
  `eqp/{id}/event`, `eqp/{id}/alarm`, `eqp/{id}/state`, `eqp/{id}/metrology`,
  `eqp/{id}/cmd`, `fdc/alarm`, `qms/alarm` …). 시스템끼리는 서로 직접 호출하지 않고
  토픽만 구독하므로 나중에 MQTT/Kafka로 바꿔도 시스템 코드는 그대로입니다.
  라우팅마다 켜고 끌 수 있어 시스템 장애·누락 상황도 시험할 수 있습니다.

## 화면

| 화면 | 내용 |
|---|---|
| **설비 콘솔** | 제조사와 무관한 단일 설비 UI. 상태(E10·제어·공정·Hold), 명령(Online/Offline, Carrier 투입, Lot 시작, 일시정지/재개, Abort, 알람 리셋, PM, 운영 모드, Host 경유 원격 명령), 챔버·Load Port 슬롯 맵 |
| ├ Trace | 챔버별 실시간 PV/SP 차트(Step 구간 표시), 현재값 표 |
| ├ 레시피 | Step·시간·설정값 편집, 레시피 추가/복사/삭제 |
| ├ 알람 | 현재 알람·리셋, 알람 정의와 수동 발생 |
| ├ 이벤트 (ERD) | 통합 형식 이벤트 리포트 실시간 로그, CSV |
| ├ 데이터 생성 | 아래 "데이터 생성 설정" 전부 |
| ├ Fault 주입 | SHIFT · DRIFT · SPIKE · NOISE · STUCK · DROPOUT |
| └ 제조사 원본 | 원본 프레임(SML/XML/JSON)과 파라미터 매핑표 |
| **EES** | Fab OEE, 설비별 가용률·가동률·성능·양품률·OEE·MTBF·MTTR·WPH, E10 타임라인, 이벤트 로그, Lot 이력, 장기 UDT·링크 끊김 경보 |
| **FDC** | Run 목록과 판정, Step 구분 Trace + 이전 Run 겹쳐보기, Step 지표(mean/std/min/max)와 관리 한계, 지표 추세·한계 수정·재학습, Fault 이력, 설정 |
| **QMS** | SPC 차트(챔버별 색, USL/LSL/UCL/LCL), Cp/Cpk, Western Electric 규칙, Lot 보류·해제·재작업·폐기, 규격 수정 |
| **AMS** | 알람 생명주기(발생→확인→해제/종결), 중복 묶음, 알림 규칙·수신 그룹, 에스컬레이션, 30분 보류, 알람 폭주 감지, 통계 |
| **데이터 흐름** | 제조사 → 어댑터 → 버스 → 시스템 흐름, 라우팅 표(전달 수·속도·켜기/끄기), 최근 버스 메시지 |
| **시나리오** | 설비 추가/삭제, 시나리오 JSON 내보내기/불러오기, 시드 재시작, 기본값 초기화, CSV 내보내기 |

## 데이터 생성 설정 (설비별)

| 항목 | 설명 |
|---|---|
| Trace 생성 · 샘플링 주기(ms) · 대기 중 보고 · 보고 파라미터 | Trace 데이터 양과 대상 |
| 노이즈 배율 · 챔버 노화(웨이퍼당) | 신호 특성. 노화는 PM으로 초기화 |
| 이벤트별 보고 on/off · 추가 리포트 변수(SV) | ERD 구성 (S2F33/S2F35·S2F37 개념) |
| 자동 Lot 투입 · 투입 간격 · Lot당 웨이퍼 · 교체 시간 · 기본 레시피 | 생산 흐름 |
| 계측 샘플링 비율 | QMS로 가는 품질 데이터 양 |
| 랜덤 알람(회/시간) · 정지 알람 자동 복구 | 알람 발생 |
| PM 주기(웨이퍼) · PM 소요 | 보전 |

## 시스템 동작 요약

- **FDC**: 매 Run의 Step마다 파라미터 지표(mean/std/min/max)를 계산합니다.
  처음 N Run(기본 5)으로 챔버·레시피·Step·파라미터·지표별 한계를 학습하고(σ 기반
  + 허용오차 하한), 위반 시 SHIFT/DRIFT/SPIKE/NOISE/STUCK으로 분류합니다.
  CRITICAL이면 설비에 HOLD를 보냅니다(인터락 정책 OFF/CRITICAL/ALL). 샘플 단위
  실시간 밴드 검사도 합니다. Step 초반 과도구간, 일시정지된 Step, 램프 Step은
  판정에서 뺍니다. 정상 상태 오경보율은 Run 대비 약 1% 이하입니다(테스트로 확인).
- **QMS**: 설비×항목별 I-차트. 처음 20포인트로 관리한계를 학습(MR/1.128)합니다.
  OOS → Lot 보류 + 알람, OOC 규칙(R1/R2/R3/R5) → 알람, 연속 OOS Lot 3개 →
  설비 HOLD. 포인트마다 FDC 판정이 붙어 품질 이탈을 원인 Run까지 추적할 수 있습니다.
- **EES**: Host 쪽에서 E10 상태 시간을 누적해 KPI를 계산합니다. ERD 로그와 Lot 이력을
  보관합니다.
- **AMS**: 네 출처(EQP/FDC/QMS/EES)의 알람을 한곳에서 관리합니다. 규칙에 따라
  수신 그룹에 (모의) 알림을 보내고, 미확인 알람은 시간에 따라 단계별로 올립니다.

## 용어 가정

- **ERD**: Event Report Data — S6F11 이벤트 리포트(CEID + 리포트 변수)로 해석했습니다.
- **AMS**: Alarm Management System으로 해석했습니다(자산 관리가 아님).
- **EES**: Equipment Engineering System — 설비 상태·가동 지표·이벤트 이력.
- SEMI E10(설비 상태), E30 GEM(제어 상태·원격 명령), E5 SECS-II(메시지 형식)의
  개념을 따르지만 표준을 완전히 구현한 것은 아닙니다.

## 한계와 다음 단계

- 실제 HSMS(SEMI E37) 소켓은 열지 않습니다. 원본 프레임은 형식을 보여 주고
  어댑터 변환을 시험하는 용도입니다. 실제 Host 연결이 필요하면 HSMS 서버를
  `VendorLink` 앞단에 붙이면 됩니다.
- 버스는 프로세스 내부 구현입니다. MQTT/Kafka 어댑터로 바꾸면 시스템을 별도
  프로세스로 나눌 수 있습니다.
- 이력·학습 모델은 메모리에만 있습니다(설정만 `data/scenario.json`에 저장).
  장기 보관이 필요하면 시계열 DB를 붙이세요.
- FDC는 단변량 지표만 씁니다. 다변량(T²/PCA) 모델은 다음 단계 후보입니다.
- 인증·권한이 없습니다. 로컬(127.0.0.1)에서만 쓰세요.
