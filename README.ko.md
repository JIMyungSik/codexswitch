# codexswitch

[English](README.md) | **한국어**

**OpenAI Codex CLI 계정을 여러 개 등록해두고, 클릭 한 번(명령 한 줄)으로 전환하거나, 사용량 한도에 걸리면 자동으로 다음 계정으로 넘어가게 해주는 도구입니다.**

[KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude)(Claude용 멀티 계정 도구)에서 영감을 받아 Codex CLI에 맞게 만들었습니다. macOS / Windows / Linux를 지원하며, Node.js만 있으면 되고 외부 의존성은 없습니다.

## 이런 분께 필요합니다

- ChatGPT 계정이 2개 이상 있고(개인용/회사용, Plus/Pro 등) Codex를 계정 바꿔가며 쓰고 싶은 분
- 한 계정의 사용량 한도(usage limit)가 차면 **자동으로 다른 계정으로 이어서** 작업하고 싶은 분
- 매번 `codex logout` → `codex login`을 반복하는 게 지겨운 분

Codex CLI는 로그인 정보를 한 파일(`auth.json`)에만 저장해서 원래 계정 1개만 쓸 수 있습니다. codexswitch가 이 한계를 풀어줍니다.

---

## 1. 준비물

두 가지가 미리 설치되어 있어야 합니다.

### ① Node.js (v18 이상)

터미널에서 `node --version`을 입력했을 때 `v18` 이상이 나오면 이 단계는 건너뛰세요.

- **macOS**: [nodejs.org](https://nodejs.org/)에서 LTS 버전 설치 파일(.pkg)을 받아 실행하거나, Homebrew가 있다면 터미널에서:
  ```bash
  brew install node
  ```
- **Windows**: [nodejs.org](https://nodejs.org/)에서 LTS 버전 설치 파일(.msi)을 받아 실행하세요. 설치 중 옵션은 전부 기본값 그대로 "다음"만 눌러도 됩니다.

### ② Codex CLI

- **macOS** — 터미널(응용 프로그램 → 유틸리티 → 터미널)에서:
  ```bash
  npm install -g @openai/codex
  ```
- **Windows** — PowerShell(시작 메뉴에서 "PowerShell" 검색 → 실행)에서:
  ```powershell
  npm install -g @openai/codex
  ```
  > 참고: Codex CLI는 Windows 네이티브 지원이 실험적(experimental) 단계라, OpenAI는 WSL(Windows Subsystem for Linux) 사용을 권장합니다. WSL을 쓰신다면 WSL 터미널 안에서 macOS/Linux 방법을 그대로 따라 하시면 됩니다.

설치 확인:

```bash
codex --version
```

---

## 2. codexswitch 설치

macOS와 Windows 모두 같은 명령입니다 (macOS는 터미널, Windows는 PowerShell):

```bash
npm install -g @carjms/codexswitch
```

설치 확인:

```bash
codexswitch help
```

도움말이 나오면 성공입니다. `codexswitch`와 짧은 별칭 `cxs` 두 명령 모두 똑같이 동작합니다 (아래 예시는 짧은 `cxs`를 사용합니다).

---

## 3. 처음 시작하기 (5분 가이드)

계정 2개를 등록하고 전환해보는 전체 과정입니다.

### 3-1. 이미 로그인된 계정 등록하기

전에 `codex login`을 해본 적이 있다면, 그 계정을 그대로 가져옵니다:

```bash
cxs import
```

```
added account "me@gmail.com" (me@gmail.com, plus)
set "me@gmail.com" as the active account
```

이름을 직접 붙이고 싶다면 `cxs import 개인용` 처럼 뒤에 이름을 쓰면 됩니다.

> 아직 한 번도 로그인한 적이 없다면 이 단계는 건너뛰고 3-2로 가세요.

### 3-2. 두 번째 계정 로그인하기

```bash
cxs login 회사용
```

브라우저가 열리면 **추가할 ChatGPT 계정으로** 로그인하세요. (이미 브라우저에 다른 계정이 로그인돼 있다면 로그인 화면에서 계정을 전환하세요.)

> 이 과정은 격리된 임시 공간에서 진행되므로 **기존 계정 로그인은 전혀 건드리지 않습니다.**

### 3-3. 등록된 계정 확인

```bash
cxs list
```

```
   name          email             plan  prio  status  token refreshed
-  ------------  ----------------  ----  ----  ------  ----------------
*  me@gmail.com  me@gmail.com      plus  0     ok      2026-07-08 09:12
   회사용         work@company.com  pro   0     ok      2026-07-08 09:15
```

`*` 표시가 현재 활성 계정입니다.

### 3-4. 계정 전환

```bash
cxs use 회사용
```

이제부터 평소처럼 `codex`를 실행하면 회사용 계정으로 동작합니다. 다시 바꾸려면 `cxs use me@gmail.com`, 또는 `cxs next`(다음 계정으로 순환).

### 3-5. 한도 자동 전환으로 실행하기 (핵심 기능)

```bash
cxs exec "이 프로젝트의 테스트 코드를 작성해줘"
```

`codex exec`를 실행하다가 **사용량 한도에 걸리면**:

1. 그 계정을 일정 시간 "한도 걸림"으로 표시하고 (에러 메시지의 "try again in 2 hours" 같은 시간을 자동 인식)
2. 다음 사용 가능한 계정이 **같은 세션을 그대로 이어받아**(`codex exec resume`) 중단 지점부터 계속합니다 — 처음부터 다시 시작하지 않습니다 (원치 않으면 `--no-resume`)
3. 모든 계정이 소진되면 그때 멈춥니다

```
[codexswitch] exec as "me@gmail.com"
... (작업 중 한도 도달) ...
[codexswitch] "me@gmail.com" hit a usage/rate limit (paused until 2026-07-08 14:30) — rotating
[codexswitch] exec as "회사용" (attempt 2)
... (이어서 작업) ...
```

### 3-6. 계정 전환 없이 특정 계정으로 실행

전역 활성 계정은 그대로 두고, 이번 한 번만 다른 계정으로 실행할 수도 있습니다:

```bash
cxs run 회사용            # 회사용 계정으로 codex 대화형 실행
cxs run 회사용 exec "..."  # 회사용 계정으로 codex exec 실행
```

각 계정은 격리된 자기만의 환경에서 실행되므로, **터미널 2개를 열어 서로 다른 계정으로 동시에 codex를 돌릴 수도 있습니다.** (설정과 세션 기록은 공유됩니다.)

### 3-7. 계정 순서와 기본 모델 설정

로테이션 순서를 한 번에 지정할 수 있습니다. 이후 `exec`와 `next`는 이 순서를 따릅니다:

```bash
cxs order 회사용 me@gmail.com   # 회사용 → me@gmail.com 순서로 사용
cxs order                       # 현재 순서 확인
```

기본 모델을 정해두면 `run`/`exec` 실행 시 자동으로 적용됩니다 (`-m`을 직접 쓰면 그쪽이 우선):

```bash
cxs model gpt-5.2-codex   # 기본 모델 설정
cxs model                 # 현재 설정 확인
cxs model default         # codex 기본값으로 되돌리기
```

### 3-8. OpenAI API 키 계정 등록

ChatGPT 구독 대신 API 크레딧(Platform 과금)으로 쓰는 계정도 등록할 수 있습니다:

```bash
cxs add-key api계정 sk-여기에API키
```

> 팁: 셸 히스토리에 키를 남기고 싶지 않다면 키를 생략하고 환경변수로 전달하세요:
> `OPENAI_API_KEY=sk-... cxs add-key api계정`

### 3-9. 한도 임계치 설정 (몇 %에서 다음 계정으로 넘길지)

5시간/주간 사용량이 설정한 퍼센트에 도달한 계정은 로테이션에서 자동으로 건너뜁니다 (기본 95%):

```bash
cxs threshold 90        # 5시간·주간 모두 90%
cxs threshold 90 98     # 5시간 90%, 주간 98%
cxs threshold           # 현재 설정 확인
cxs list                # 계정별 5h/week 사용량 % 확인
```

> 사용량 수치는 codex가 세션 기록에 남기는 값을 읽습니다. codex 버전에 따라 `exec` 모드에서는 이 값을 기록하지 않을 수 있는데, 그 경우 대화형 실행(`cxs run`) 후에 갱신됩니다. 수치가 없으면 임계치 대신 한도 에러 감지 방식으로만 동작합니다.

---

## 4. 명령어 전체 목록

| 명령 | 설명 |
|---|---|
| `cxs login [이름]` | 새 계정 로그인 후 저장 (기존 로그인 유지, 이름 생략 시 이메일 사용) |
| `cxs import [이름]` | 현재 `~/.codex`에 로그인된 계정을 저장소로 가져오기 |
| `cxs add-key <이름> [키]` | OpenAI API 키 계정 등록 (키 생략 시 `$OPENAI_API_KEY` 사용) |
| `cxs list` | 계정 목록: 활성 표시, 이메일, 플랜, 우선순위, 한도 상태, 사용량 % |
| `cxs usage [이름]` | 계정별 사용량 대시보드: 5시간/주간 게이지 바, 리셋 카운트다운, 다음 로테이션 계정 (별칭: `status`) |
| `cxs chat` | **대화형 입력창 (Claude Code 스타일)**: 매 턴이 로테이션을 거치고 같은 codex 세션을 이어가므로, 계정이 바뀌어도 대화가 유지됨. 내부 명령: `/usage /use /next /model /new /quit` |
| `cxs watch` | 실시간 인터랙티브 대시보드 — 5초마다 갱신; 키: `↑/↓` 선택, `s` 전환, `e` 활성/비활성, `p` 프로브, `q` 종료 |
| `cxs probe [이름]` | 계정마다 최소 요청 1회를 보내 사용량 게이지 워밍업 (토큰 소량 소모) |
| `cxs log [개수]` | 최근 활동 기록: 계정 전환, 한도 도달, 로테이션, 프로브 |
| `cxs use <이름>` | 활성 계정 전환 |
| `cxs current` | 현재 활성 계정 확인 |
| `cxs next` | 설정된 순서의 다음 계정으로 전환 (끝에 오면 처음으로 순환) |
| `cxs run [이름] [인자...]` | 전환 없이 특정 계정으로 codex 실행 (격리 환경) |
| `cxs exec [인자...]` | `codex exec` + 한도 도달 시 순서대로 자동 로테이션 — 다음 계정이 같은 세션을 이어받음. git 저장소가 아닌 폴더에서도 동작 |
| `cxs exec -a <이름> ...` | 특정 계정부터 exec 시작 (`--no-resume`: 이어받기 대신 처음부터 재시도) |
| `cxs order [이름들...]` | 로테이션 순서 고정(pin); 나열하지 않은 계정은 **주간 리셋이 빠른 순**으로 자동 소진 (use-or-lose) |
| `cxs model [모델명]` | `run`/`exec`에 자동 적용할 기본 모델 설정 (`default`로 초기화) |
| `cxs threshold [5h%] [주간%]` | 사용량이 이 퍼센트에 도달하면 다음 계정으로 전환 (기본 95, 값 하나면 둘 다) |
| `cxs reasoning <show\|concise\|hide>` | 실행 중 모델 추론("생각") 출력량 조절 — `hide`는 완전 숨김, `concise`는 한 줄 요약 |
| `cxs sandbox <read-only\|write\|full>` | exec/chat의 파일 접근 권한 — codex exec 기본은 읽기 전용; `write`면 작업 폴더 파일 수정 가능 |
| `cxs patterns [add/remove]` | 한도 감지에 쓸 커스텀 정규식 패턴 추가/삭제 |
| `cxs export <파일>` | 전체 계정·설정 백업 (⚠️ 토큰 포함 — 비밀번호처럼 취급) |
| `cxs restore <파일>` | 백업 파일에서 계정 복원 (다른 PC 이전용) |
| `cxs completion <bash\|zsh>` | 셸 자동완성 스크립트 출력 |
| `cxs <그 외 명령>` | codex로 그대로 전달 — `cxs resume`, `cxs goal ...`, `cxs apply` 등 codex의 모든 명령을 관리 계정으로 바로 사용 가능 |
| `cxs server [--port N]` | **실험 기능** 로컬 프록시(teamclaude 방식): 요청마다 인증을 교체하고, 429는 다음 계정으로 재시도, 응답 헤더에서 사용량을 실시간 수집 |
| `cxs run --proxy [인자]` | codex를 로컬 프록시 경유로 실행 — 대화형 세션 안에서도 요청 단위 로테이션 |
| `cxs remove <이름>` | 계정 삭제 |
| `cxs rename <옛이름> <새이름>` | 계정 이름 변경 |
| `cxs disable / enable <이름>` | 로테이션에서 임시 제외 / 복귀 |
| `cxs priority <이름> <숫자\|auto>` | 계정 하나의 순위 고정, `auto`면 고정 해제(리셋 빠른 순 자동 로테이션) |
| `cxs clear-limit <이름>` | 기록된 한도 상태 수동 해제 |
| `cxs cooldown [분]` | 한도 감지 시 기본 대기 시간 조회/설정 (기본 60분) |
| `cxs sync` | codex가 갱신한 토큰을 저장소에 반영 |

---

## 5. 자주 묻는 질문 / 문제 해결

**Q. `codexswitch: command not found` (또는 "인식할 수 없는 명령") 이 떠요.**
npm 전역 설치 경로가 PATH에 없는 경우입니다. 터미널/PowerShell을 **완전히 닫았다 다시 열어보세요.** 그래도 안 되면 `npm config get prefix`로 나온 경로(Windows는 그 경로 자체, macOS는 그 아래 `bin` 폴더)를 PATH에 추가하세요.

**Q. macOS에서 `npm install -g` 하다가 `EACCES` 권한 오류가 나요.**
`sudo npm install -g @carjms/codexswitch`로 설치하거나, 더 좋은 방법으로는 [nvm](https://github.com/nvm-sh/nvm)으로 Node.js를 설치하면 권한 문제가 사라집니다.

**Q. `codex CLI not found` 오류가 나요.**
Codex CLI가 설치되지 않았거나 PATH에 없는 경우입니다. `npm install -g @openai/codex` 후 다시 시도하세요. 특별한 위치에 설치했다면 환경변수 `CODEX_SWITCH_CODEX_BIN`에 전체 경로를 지정하면 됩니다.

**Q. `Not inside a trusted directory and --skip-git-repo-check was not specified.` 오류가 나요.**
Codex CLI 자체의 안전장치로, git 저장소가 아닌 폴더에서는 `codex exec` 실행을 거부합니다. **v0.2.0부터 `cxs exec`는 이 옵션을 자동으로 붙여주므로 이 오류가 나지 않습니다.** 대화형 실행(`cxs run`)에서는 codex가 직접 "이 폴더를 신뢰하시겠습니까?"라고 물어보니 승인하면 됩니다.

**Q. 계정을 전환하면 기존 대화 세션이나 설정이 날아가나요?**
아니요. 전환되는 것은 **인증 정보(auth.json)뿐**입니다. `config.toml` 설정, 세션 기록, 스킬 등은 모든 계정이 공유합니다.

**Q. Windows에서 `run`/`exec`가 잘 동작하나요?**
동작합니다. 내부적으로 macOS/Linux는 심볼릭 링크, Windows는 디렉토리 정션(관리자 권한 불필요)을 사용합니다. 파일 공유까지 완전하게 하려면 Windows **설정 → 개발자 모드**를 켜는 것을 추천하지만, 꺼져 있어도 복사 방식으로 자동 대체되어 문제없이 동작합니다.

**Q. 한도에 걸렸다고 표시된 계정을 바로 다시 쓰고 싶어요.**
`cxs clear-limit <이름>` 으로 해제하면 됩니다.

**Q. 계정 이름에 한글을 써도 되나요?**
네. `회사용`, `개인용` 같은 한글 이름 모두 가능합니다. (허용 문자: 한글 등 모든 언어의 글자, 숫자, 공백, `@ . _ + -`)

**Q. 여러 계정을 쓰는 게 약관에 문제되지 않나요?**
본인 소유의 정당한 계정들(예: 개인 계정과 회사 계정)을 전환하는 용도로 사용하세요. 한도 우회를 목적으로 한 계정 남용은 OpenAI 이용약관에 어긋날 수 있으며, 사용에 대한 책임은 사용자에게 있습니다.

---

## 6. 데이터가 저장되는 위치

| 항목 | macOS/Linux | Windows |
|---|---|---|
| 계정 저장소 | `~/.codex-switch/` | `C:\Users\<사용자>\.codex-switch\` |
| Codex 설정 | `~/.codex/` | `C:\Users\<사용자>\.codex\` |

```
.codex-switch/
├── meta.json              # 활성 계정, 우선순위, 한도 상태, 쿨다운 설정
├── accounts/<이름>.json    # 계정별 인증 정보 사본 (권한 600)
└── profiles/<이름>/        # run/exec용 계정별 격리 실행 환경
```

### 환경변수로 위치 바꾸기

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CODEX_SWITCH_HOME` | `~/.codex-switch` | 계정 저장소 위치 |
| `CODEX_HOME` | `~/.codex` | 관리 대상 codex 설정 디렉토리 |
| `CODEX_SWITCH_CODEX_BIN` | `codex` | codex 바이너리 경로 |

- macOS/Linux: `export CODEX_SWITCH_HOME=/원하는/경로`
- Windows PowerShell: `$env:CODEX_SWITCH_HOME = "D:\원하는\경로"` (영구 설정은 `setx CODEX_SWITCH_HOME "D:\원하는\경로"`)

---


## 개발

```bash
git clone https://github.com/JIMyungSik/codexswitch.git
cd codexswitch
npm link       # 로컬 개발 버전을 전역 명령으로 연결
npm test       # 가짜 codex 바이너리로 전체 흐름 검증 (실제 ~/.codex는 건드리지 않음)
```

## 라이선스

MIT
