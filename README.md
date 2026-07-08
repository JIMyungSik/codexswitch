# codexteam

**OpenAI Codex CLI 계정을 여러 개 등록해두고, 클릭 한 번(명령 한 줄)으로 전환하거나, 사용량 한도에 걸리면 자동으로 다음 계정으로 넘어가게 해주는 도구입니다.**

[KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude)(Claude용 멀티 계정 도구)에서 영감을 받아 Codex CLI에 맞게 만들었습니다. macOS / Windows / Linux를 지원하며, Node.js만 있으면 되고 외부 의존성은 없습니다.

## 이런 분께 필요합니다

- ChatGPT 계정이 2개 이상 있고(개인용/회사용, Plus/Pro 등) Codex를 계정 바꿔가며 쓰고 싶은 분
- 한 계정의 사용량 한도(usage limit)가 차면 **자동으로 다른 계정으로 이어서** 작업하고 싶은 분
- 매번 `codex logout` → `codex login`을 반복하는 게 지겨운 분

Codex CLI는 로그인 정보를 한 파일(`auth.json`)에만 저장해서 원래 계정 1개만 쓸 수 있습니다. codexteam이 이 한계를 풀어줍니다.

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

## 2. codexteam 설치

macOS와 Windows 모두 같은 명령입니다 (macOS는 터미널, Windows는 PowerShell):

```bash
npm install -g codexteam
```

설치 확인:

```bash
codexteam help
```

도움말이 나오면 성공입니다. `codexteam`과 짧은 별칭 `cxs` 두 명령 모두 똑같이 동작합니다 (아래 예시는 짧은 `cxs`를 사용합니다).

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
2. 다음 사용 가능한 계정으로 **같은 명령을 자동 재시도**합니다
3. 모든 계정이 소진되면 그때 멈춥니다

```
[codexteam] exec as "me@gmail.com"
... (작업 중 한도 도달) ...
[codexteam] "me@gmail.com" hit a usage/rate limit (paused until 2026-07-08 14:30) — rotating
[codexteam] exec as "회사용" (attempt 2)
... (이어서 작업) ...
```

### 3-6. 계정 전환 없이 특정 계정으로 실행

전역 활성 계정은 그대로 두고, 이번 한 번만 다른 계정으로 실행할 수도 있습니다:

```bash
cxs run 회사용            # 회사용 계정으로 codex 대화형 실행
cxs run 회사용 exec "..."  # 회사용 계정으로 codex exec 실행
```

각 계정은 격리된 자기만의 환경에서 실행되므로, **터미널 2개를 열어 서로 다른 계정으로 동시에 codex를 돌릴 수도 있습니다.** (설정과 세션 기록은 공유됩니다.)

---

## 4. 명령어 전체 목록

| 명령 | 설명 |
|---|---|
| `cxs login [이름]` | 새 계정 로그인 후 저장 (기존 로그인 유지, 이름 생략 시 이메일 사용) |
| `cxs import [이름]` | 현재 `~/.codex`에 로그인된 계정을 저장소로 가져오기 |
| `cxs list` | 계정 목록: 활성 표시(`*`), 이메일, 플랜, 우선순위, 한도 상태 |
| `cxs use <이름>` | 활성 계정 전환 |
| `cxs current` | 현재 활성 계정 확인 |
| `cxs next` | 다음 사용 가능한 계정으로 순환 전환 |
| `cxs run [이름] [인자...]` | 전환 없이 특정 계정으로 codex 실행 (격리 환경) |
| `cxs exec [인자...]` | `codex exec` + 한도 도달 시 자동 계정 로테이션 |
| `cxs exec -a <이름> ...` | 특정 계정부터 exec 시작 |
| `cxs remove <이름>` | 계정 삭제 |
| `cxs rename <옛이름> <새이름>` | 계정 이름 변경 |
| `cxs disable / enable <이름>` | 로테이션에서 임시 제외 / 복귀 |
| `cxs priority <이름> <숫자>` | 로테이션 우선순위 (낮을수록 먼저, 기본 0) |
| `cxs clear-limit <이름>` | 기록된 한도 상태 수동 해제 |
| `cxs cooldown [분]` | 한도 감지 시 기본 대기 시간 조회/설정 (기본 60분) |
| `cxs sync` | codex가 갱신한 토큰을 저장소에 반영 |

---

## 5. 자주 묻는 질문 / 문제 해결

**Q. `codexteam: command not found` (또는 "인식할 수 없는 명령") 이 떠요.**
npm 전역 설치 경로가 PATH에 없는 경우입니다. 터미널/PowerShell을 **완전히 닫았다 다시 열어보세요.** 그래도 안 되면 `npm config get prefix`로 나온 경로(Windows는 그 경로 자체, macOS는 그 아래 `bin` 폴더)를 PATH에 추가하세요.

**Q. macOS에서 `npm install -g` 하다가 `EACCES` 권한 오류가 나요.**
`sudo npm install -g codexteam`로 설치하거나, 더 좋은 방법으로는 [nvm](https://github.com/nvm-sh/nvm)으로 Node.js를 설치하면 권한 문제가 사라집니다.

**Q. `codex CLI not found` 오류가 나요.**
Codex CLI가 설치되지 않았거나 PATH에 없는 경우입니다. `npm install -g @openai/codex` 후 다시 시도하세요. 특별한 위치에 설치했다면 환경변수 `CODEX_SWITCH_CODEX_BIN`에 전체 경로를 지정하면 됩니다.

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

## 7. 설계 (어떻게 동작하나)

### 핵심 아이디어 3가지

**1. 계정 전환 = auth.json 교체 (`use`)**
Codex CLI는 인증을 `auth.json` 파일 하나로 관리합니다. 저장해둔 계정별 사본을 원자적(atomic rename)으로 써넣는 것만으로 계정이 바뀌고, 설정·세션·히스토리는 그대로 유지됩니다.

**2. 오버레이 프로필 = 전환 없는 격리 실행 (`run` / `exec`)**
Codex CLI는 `CODEX_HOME` 환경변수로 설정 디렉토리를 바꿀 수 있습니다. 계정마다 프로필 디렉토리를 만들되 `auth.json`만 실제 파일로 두고, 나머지(`config.toml`, `sessions/`, `skills/` 등)는 실제 `~/.codex`로 연결(macOS/Linux: 심볼릭 링크, Windows: 정션/복사)합니다. 설정과 세션은 공유하면서 인증만 격리되므로 서로 다른 계정으로 동시 실행이 가능합니다. (sqlite 파일은 동시 접근 시 손상 위험이 있어 공유하지 않습니다.)

**3. 한도 기반 자동 로테이션 (`exec`)** — teamclaude의 핵심 개념
`codex exec`의 출력을 실시간으로 흘려보내면서 동시에 수집해 `usage limit / rate limit / 429` 패턴을 감지합니다. 감지되면 해당 계정을 쿨다운 처리(에러 메시지의 "try again in N hours" 파싱, 실패 시 기본 60분)하고, 우선순위 순으로 다음 계정을 골라 같은 명령을 재시도합니다. 한도가 아닌 일반 오류는 로테이션하지 않고 그대로 종료 코드를 전달합니다.

### 토큰 수명 관리

codex는 실행 중 스스로 토큰을 갱신해 `auth.json`을 다시 씁니다. 갱신본이 유실되지 않도록 계정 전환 직전과 `run`/`exec` 종료 시점에 현재 auth.json을 저장소로 **sync-back**합니다 (토큰의 `account_id`로 매칭, `last_refresh`가 최신일 때만 덮어씀).

### 보안

- 인증 파일은 권한 `600`, 디렉토리는 `700`으로 생성 (macOS/Linux)
- 토큰을 화면에 출력하지 않음 — JWT는 이메일/플랜 표시용으로만 로컬 디코딩
- 네트워크 요청 없음 — 모든 인증/갱신은 codex CLI 자신이 수행

### teamclaude와의 차이

teamclaude는 로컬 MITM 프록시로 API 트래픽을 가로채 할당량을 실시간 추적하며 요청 단위로 계정을 바꿉니다. Codex CLI는 할당량 조회를 외부에 노출하지 않으므로, codexteam는 프록시 대신 **프로필 전환 + 출력 감지 기반의 명령 단위 로테이션**이라는 더 단순하고 안전한 방식을 택했습니다.

---

## 개발

```bash
git clone https://github.com/JIMyungSik/codexteam.git
cd codexteam
npm link       # 로컬 개발 버전을 전역 명령으로 연결
npm test       # 가짜 codex 바이너리로 전체 흐름 검증 (실제 ~/.codex는 건드리지 않음)
```

## 라이선스

MIT
