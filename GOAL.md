# Lodestar — 빌드 프롬프트 (GOAL)

> 이 문서를 AI 코딩 에이전트(claude code 등)에게 그대로 던지면 **Lodestar**를 처음부터 만들 수 있다.
> 디자인은 `D:\winCudeProject\oneForAll\llm_wiki`의 룩앤필을 **그대로 모사**한다 — 아래에 토큰·폰트·레이아웃 골격을 전부 못 박아 두었으니 그 위키 소스를 따로 열지 않아도 된다.

---

## 0. 한 줄 정의

여러 **WCC/GSD 기반 프로젝트**가 GSD 워크플로우의 어느 단계까지 왔는지를 **n8n 풍 노드 캔버스 한 화면**으로 보여주고, 논의(discuss/plan) 단계에서는 의견을 적어 `claude -p`로 그 프로젝트 맥락에 주입하는 **Windows 데스크톱 앱**을 만든다.

핵심 성질 두 가지:
- **읽기 전용 스캐너**: 각 프로젝트의 `.planning/` 산출물을 읽어 phase·진행도·논의거리를 역산한다. GSD를 다시 돌리지 않고, 소스 코드를 건드리지 않는다.
- **쓰기는 의견 주입 한 곳뿐**: 논의 질문에 답을 적으면 `.planning/NN-DISCUSS-INBOX.md`에 기록하고, `claude -p`가 맥락에 맞게 정리해 같은 파일에 덧붙인다.

---

## 1. 기술 스택 / 프로젝트 골격

- **Electron** 데스크톱 앱 (메인/프리로드/렌더러 3분할). 번들러·프레임워크 없이 **vanilla JS 렌더러**로 충분하다. (원본은 React/Tauri가 아니라 Electron + 순수 JS 렌더러다.)
- 패키징: `electron-builder --win portable` → `release\Lodestar-<ver>-portable.exe` (설치 불필요 단일 exe).
- 외부 런타임 의존성 최소화. YAML frontmatter 파싱에 `js-yaml`만 사용.
- 폴더 구조:
  - `main.js` — Electron 메인. IPC: 폴더 선택/스캔/주입 미리보기·실행.
  - `preload.js` — `contextBridge`로 안전한 API만 노출 (nodeIntegration 끔, contextIsolation 켬).
  - `src/scanner.js` — `.planning/`을 읽어 phase·진행도·질문을 역산하는 **읽기 전용** 모듈.
  - `src/claudeRunner.js` — 인박스 파일 기록 + `claude -p` 호출.
  - `renderer/index.html`, `renderer/styles.css`, `renderer/app.js` — 대시보드 UI.
  - `renderer/fonts/` — Geist 폰트 **오프라인 번들**(woff2). CDN 의존 금지.
- 비개발자 실행: `release\Lodestar-1.0.0-portable.exe` 더블클릭 → `＋ 폴더 선택`으로 GSD 프로젝트 폴더(여러 개) 선택.

---

## 2. 디자인 시스템 — llm_wiki 룩앤필 **그대로 모사**

shadcn(oklch) 토큰 + Geist 폰트 + 좌측 아이콘 사이드바 골격을 동일하게 재현한다. Tailwind 없이 만들 경우 아래 CSS 변수를 `:root` / `.dark`에 그대로 넣고 직접 매핑한다.

### 2-1. 색상 토큰 (CSS 변수, oklch)

```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --radius: 0.625rem;
  --sidebar: oklch(0.985 0 0);
  --sidebar-border: oklch(0.922 0 0);
}

.dark {
  --background: oklch(0.16 0.005 260);   /* 살짝 푸른빛 도는 차콜 — 순흑 아님 */
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0.005 260);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0.005 260);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0.005 260);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0.005 260);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0.005 260);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 12%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --sidebar: oklch(0.18 0.005 260);
  --sidebar-border: oklch(1 0 0 / 10%);
}
```

- 라이트는 순백·순흑 무채색, 다크는 **hue 260의 미세한 푸른빛**이 핵심(완전 검정 금지).
- radius 기준값 `0.625rem`. sm=×0.6, md=×0.8, lg=×1.0.

### 2-2. 폰트

- **Geist Variable** (sans 본문 + heading 동일 폰트). `renderer/fonts/`에 woff2를 번들하고 `@font-face`로 로컬 로드. CDN/네트워크 의존 금지.
- 본문 기본은 `font-family: 'Geist Variable', sans-serif`.

### 2-3. 좌측 아이콘 사이드바 (llm_wiki와 동일 골격)

- 폭 **48px**, 세로 풀하이트, `background: var(--sidebar)` 느낌의 `muted/50`, 우측 1px border.
- 최상단: **로고 8×8px, `border-radius: 22%`**.
- 그 아래 메인 네비 아이콘 버튼: **40×40px, radius-md**, 아이콘은 **lucide 아이콘 20px**.
  - 비활성: `color: muted-foreground`, hover 시 `background: accent/50`.
  - 활성: `background: accent`, `color: accent-foreground`.
  - 배지(개수)는 우상단 `rounded-full`, `background: primary`, 10px 굵은 글씨.
- 하단 고정: 상태 점(dot) → 설정(기어) → 프로젝트 전환(좌우 화살표) 순. 점은 8~10px 원, 상태별 색(running=emerald, starting=amber+pulse, error=red+pulse).
- 모든 아이콘 버튼은 **우측에 뜨는 툴팁**(delay ~300ms)으로 레이블을 보여준다.

### 2-4. 전체 레이아웃

- 바깥은 세로 컬럼: (선택) 상단 풀폭 배너 → 메인 행.
- 메인 행: `[48px 아이콘 사이드바] [좌측 패널] [중앙 캔버스] [우측 드로어]`.
  - 좌측 패널 = **프로젝트 트리 사이드바**, 기본 220px, 드래그 리사이즈(150~400px 캡).
  - 중앙 = **n8n 노드 캔버스**(아래 3-2).
  - 우측 = **논의 드로어**, 기본 ~400px, 드래그 리사이즈(250px~컨테이너 50%).
  - 리사이즈 핸들: 폭 6px, `background: border/40`, hover `primary/30`, `cursor: col-resize`.
- **우상단 ◐ 버튼**으로 라이트/다크 토글. 토글 시 `<html>`(또는 root)에 `.dark` 클래스 부착/제거.
- **우하단 단계 범례(legend)**: phase 상태 색-의미 매핑을 작게 표시. 얇은 스크롤바(4px).

---

## 3. 기능 명세

### 3-1. 읽기 — `.planning` 스캐너 (`src/scanner.js`, 읽기 전용)

각 프로젝트 폴더에서 다음을 읽어 phase·진행도·논의거리를 역산한다.

- **`STATE.md` frontmatter**(js-yaml 파싱): `milestone`, `status`, `progress.{completed/total phases·plans, percent}`.
- **`ROADMAP.md`의 `## Phases`**: phase 번호·제목. 아카이브된 `<details>` 블록은 **제외**.
- **`phases/NN-slug/` 산출물 파일로 단계 역산**:
  - `NN-CONTEXT.md` → 논의 완료
  - `NN-RESEARCH.md` → 조사 완료
  - `NN-MM-PLAN.md` → 계획 (개수 카운트)
  - `NN-MM-SUMMARY.md` → 실행 완료 (개수 카운트)
  - `NN-VERIFICATION.md` → 검증
- **논의 질문 추출**: `NN-CONTEXT.md`의 회색지대/Discretion 항목 + `NN-DISCUSSION-LOG.md`의 질문. `CONTEXT.md`가 아직 없는 현재 phase는 **"논의 시작 필요"** 로 표시.
- 폴더가 `.planning/`을 갖지 않으면 "GSD 프로젝트 아님"으로 건너뛴다.

### 3-2. 표시 — n8n 노드 캔버스 (`renderer/app.js`)

- 프로젝트 1개 = **가로 레인 1줄**. phase 1개 = **노드 1개**.
- 노드는 **베지에 곡선**으로 좌→우 연결.
- **현재 실행 중 phase**: 펄스 애니메이션 + 연결선에 **점선 흐름 애니메이션**으로 강조.
- 캔버스는 **팬(드래그)·줌(휠)** 가능.
- 노드 상태색은 우하단 범례와 일치(예: 완료/진행중/대기/논의필요/검증). 색은 §2 토큰 위에서 chart 계열 또는 상태별 액센트로 구성.
- 좌측 프로젝트 트리에서 항목 클릭 시 해당 레인으로 포커스/스크롤.

### 3-3. 쓰기 — 의견 주입 (`src/claudeRunner.js`)

- 논의(💬) 노드 클릭 → **우측 드로어**가 열려 해당 phase의 질문 목록과 입력란을 보여준다.
- 의견 입력 → **미리보기**(주입될 텍스트 확인) → **확인 — claude -p 실행**.
- 동작 순서:
  1. 입력 의견을 `.planning/NN-DISCUSS-INBOX.md`에 append 기록.
  2. `claude -p`를 호출해 맥락에 맞게 정리한 결과를 **같은 파일에 덧붙임**.
  3. 소스 코드·다른 산출물은 **절대 수정하지 않음**.
- **claude 실행 파일 탐색**: `%USERPROFILE%\.local\bin\claude.exe` → PATH의 `claude` 순.
- claude 미설치 시: 의견 주입만 비활성화, **상황판 보기는 정상 동작**해야 한다.
- `claude -p` 호출은 되돌릴 수 없는 외부 단계이므로 **항상 확인 모달**을 거친다.

### 3-4. 새로고침

- `↻ 새로고침` 버튼으로 모든 프로젝트를 다시 스캔해 최신 상태를 그린다.

---

## 4. 보안 / 안전장치

- `contextIsolation: true`, `nodeIntegration: false`. 렌더러는 preload가 노출한 API만 사용.
- 파일 시스템 접근은 메인 프로세스(IPC) 경유. 스캐너는 읽기만, claudeRunner의 쓰기는 INBOX 파일 한 종류로 한정.
- 외부 명령(`claude -p`)은 항상 사용자 확인 모달 뒤에서만 실행.

---

## 5. 성공 기준 (이게 되면 완성)

1. `＋ 폴더 선택`으로 GSD 프로젝트 여러 개를 한 번에 불러오면 각각 레인+노드 파이프라인으로 그려진다.
2. STATE/ROADMAP/phases 산출물만으로 phase·진행도·논의 질문이 정확히 역산된다(아카이브 `<details>` 제외).
3. 논의 노드에서 의견 입력 → 미리보기 → 확인 모달 → `claude -p` 실행 시 `NN-DISCUSS-INBOX.md`에만 기록되고 소스는 무변경.
4. 라이트/다크 토글이 llm_wiki와 구분 안 될 만큼 동일한 토큰·폰트·사이드바 골격으로 보인다.
5. `npm run dist`로 `release\Lodestar-<ver>-portable.exe` 단일 실행 파일이 나오고, 더블클릭만으로 동작한다.

---

## 6. 빌드 환경 메모 (electron-builder 함정)

관리자 권한/개발자 모드가 꺼진 Windows에서 electron-builder가 `winCodeSign` 압축 해제 중 macOS 심볼릭 링크(`libcrypto.dylib`/`libssl.dylib`) 생성에 실패해 빌드가 멈출 수 있다(`클라이언트가 필요한 권한을 보유하지 않습니다`). 해결:
1. **개발자 모드 켜기**(설정 → 개발자용) 후 재빌드 — 가장 깔끔.
2. 또는 관리자 PowerShell에서 빌드. (`CSC_IDENTITY_AUTO_DISCOVERY=false` 권장.)
