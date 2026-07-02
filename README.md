# Lodestar — WCC / GSD 프로젝트 상황판

여러 GSD 기반 WCC 프로젝트가 GSD 워크플로우의 어느 단계까지 왔는지 한 화면에 보여주고,
논의(discuss/plan) 단계에서는 의견을 적어 `claude -p`로 그 프로젝트 맥락에 주입하는 윈도우 데스크톱 앱.

## UI/UX

- **n8n 노드 캔버스**: 각 프로젝트가 가로 레인, 각 phase가 노드. 노드는 베지에 곡선으로 연결되고
  현재 실행 중 phase는 펄스 + 연결선 흐름(점선 애니메이션)으로 강조된다. 캔버스는 팬/줌(휠·드래그) 가능.
- **디자인 시스템**: `D:\winCudeProject\oneForAll\llm_wiki`의 shadcn 라이트/다크 토큰(oklch) + Geist 폰트
  (오프라인 번들). 좌측 프로젝트 트리 사이드바 + 우하단 단계 범례. 우상단 ◐ 버튼으로 라이트/다크 전환.
- 논의(💬) 노드를 클릭하면 우측 드로어가 열려 의견을 입력·주입한다.

- **읽기**: 각 프로젝트의 `.planning/` 산출물을 읽어 phase·진행도·논의 내용을 그린다. GSD를 다시 돌리지 않는다.
- **쓰기(의견 주입)**: 논의 질문에 답을 적으면 `.planning/NN-DISCUSS-INBOX.md`에 기록하고, `claude -p`가 맥락에 맞게 정리해 같은 파일에 덧붙인다. 소스 코드는 건드리지 않는다.

## 그냥 실행하기 (비개발자용)

`release\Lodestar-1.0.0-portable.exe` 를 **더블클릭**하면 됩니다. 설치 불필요.

1. 앱이 뜨면 **＋ 폴더 선택** → GSD 프로젝트 폴더(들)를 고른다 (여러 개 가능).
2. 각 프로젝트가 카드로 뜨고 milestone·진행도·phase 파이프라인이 보인다.
3. 논의 단계(💬) 카드에서 **의견 주입 (claude -p)** 버튼 → 의견 입력 → **미리보기** → **확인 — claude -p 실행**.
   - claude -p 호출은 되돌릴 수 없는 외부 단계라 항상 확인 모달을 거친다.
4. **↻ 새로고침**으로 최신 상태를 다시 읽는다.

### 사전 요건
- `claude` CLI 설치 (의견 주입 기능용). 앱은 `%USERPROFILE%\.local\bin\claude.exe` 또는 PATH의 `claude`를 찾는다.
- 의견 주입을 안 쓰면 claude 없이도 상황판 보기는 동작한다.

## 상태 해석 방식 (어떻게 phase를 알아내나)

- `STATE.md` frontmatter: `milestone`, `status`, `progress.{total/completed phases·plans, percent}`
- `ROADMAP.md` `## Phases`: phase 번호·제목 (아카이브 `<details>` 블록은 제외)
- `phases/NN-slug/` 안의 산출물 파일로 단계 역산:
  - `NN-CONTEXT.md` → 논의 완료 · `NN-RESEARCH.md` → 조사 · `NN-MM-PLAN.md` → 계획(개수)
  - `NN-MM-SUMMARY.md` → 실행 완료(개수) · `NN-VERIFICATION.md` → 검증
- 논의 질문 = `NN-CONTEXT.md`의 회색지대/Discretion + `NN-DISCUSSION-LOG.md`의 질문.
  CONTEXT.md가 아직 없는 현재 phase는 "논의 시작 필요"로 표시.

## 개발 / 재빌드

```powershell
npm install
npm start          # 개발 실행
npm run dist       # release\Lodestar-<ver>-portable.exe 빌드 (CSC_IDENTITY_AUTO_DISCOVERY=false 권장)
```

### ⚠️ 빌드 환경 메모 — electron-builder 심볼릭 링크 오류
관리자 권한/개발자 모드가 꺼진 Windows에서 electron-builder가 `winCodeSign` 압축 해제 중
macOS 심볼릭 링크(`libcrypto.dylib`, `libssl.dylib`) 생성에 실패해 빌드가 멈춘다
(`Cannot create symbolic link ... 클라이언트가 필요한 권한을 보유하지 않습니다`).

이 저장소는 `node_modules/7zip-bin/win/x64/7za.exe`를 래퍼로 교체해 우회한다
(원본은 `7za-real.exe`, 래퍼는 7-Zip exit 1/2를 0으로 매핑 — macOS 심링크는 Windows 빌드에 무해).
`npm install`로 node_modules를 다시 받으면 이 래퍼가 사라지므로, 빌드가 같은 오류로 막히면
아래 중 하나로 해결한다:
1. **개발자 모드 켜기** (설정 → 개발자용 → 개발자 모드) 후 재빌드 — 가장 깔끔.
2. 7za 래퍼 재적용: `scripts/`의 안내 또는 관리자 PowerShell에서 빌드.

## 구조
- `main.js` — Electron 메인. IPC: 폴더 선택/스캔/주입 미리보기·실행.
- `preload.js` — contextBridge 안전 API.
- `src/scanner.js` — `.planning` 읽어 phase·진행도·질문 역산 (읽기 전용).
- `src/claudeRunner.js` — 인박스 기록 + `claude -p` 호출.
- `renderer/` — 다크 대시보드 UI.
