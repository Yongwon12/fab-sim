반도체 설비 통합 UI 테스트 시뮬레이터 **FAB-SIM** 데스크톱 앱입니다. 설치 후에는 인터넷 없이 동작하며, 네트워크 포트를 열지 않습니다.

## 다운로드

| 컴퓨터 | 파일 |
|---|---|
| 맥북 (Apple Silicon·Intel 공통) | `FAB-SIM-…-mac-universal.dmg` |
| Windows 10/11 (설치형) | `FAB-SIM-…-windows-setup.exe` |
| Windows 10/11 (설치 없이 바로 실행) | `FAB-SIM-…-windows-portable.exe` |

## 처음 실행할 때

코드 서명 인증서가 없는 테스트용 빌드라서 처음 한 번은 경고가 나옵니다.

- **macOS**: dmg를 열어 FAB-SIM을 응용 프로그램 폴더로 끌어 넣고 실행합니다. "열 수 없음" 경고가 나오면 **시스템 설정 → 개인정보 보호 및 보안**에서 맨 아래 **"그래도 열기"**를 누릅니다. 또는 터미널에서 `xattr -dr com.apple.quarantine /Applications/FAB-SIM.app` 을 실행합니다.
- **Windows**: "Windows의 PC 보호" 창이 나오면 **추가 정보 → 실행**을 누릅니다.

설정(설비 구성, Fault, 시스템 설정)은 사용자 폴더에 자동 저장됩니다. 데이터 이력은 앱을 끄면 지워집니다.
