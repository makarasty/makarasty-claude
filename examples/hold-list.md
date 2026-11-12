A hold's list on disk. Real output of `tools/skills/hold/hold.mjs` run on 2026-11-11 with
CLAUDE_CONFIG_DIR pointed at a scratch folder (`--sid demo-sid`). The skill makes these calls itself; you
only dictate and then say the codeword.

Folder: <CLAUDE_CONFIG_DIR>/makarasty/hold/<session id>/

  index.md
  01.md
  02.md
  img/          copies of screenshots you pasted, one per item
  project.txt

## index.md while collecting

collecting абрикос
01 | open | кнопка Сохранить не реагирует на второй клик |
02 | open | the date picker opens off screen on 1366x768 |

## 01.md (your words are kept verbatim in the quote block, never reworded)

# 01
time: 2026-11-11T21:31:51.854Z
status: open
where: /settings

> кнопка Сохранить не реагирует на второй клик

## The check before release

$ node hold.mjs --sid demo-sid check
01 open: кнопка Сохранить не реагирует на второй клик
02 open: the date picker opens off screen on 1366x768
index.md still reads "collecting абрикос": run release
2 of 2 items not final
(exit 1)

## index.md after the codeword, the fixes and `release`

released абрикос
01 | done | кнопка Сохранить не реагирует на второй клик |
02 | not-done | the date picker opens off screen on 1366x768 |

$ node hold.mjs --sid demo-sid check
ok, 2 items final
