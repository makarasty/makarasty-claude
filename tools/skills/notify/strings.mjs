// strings.mjs - every word the person sees on a phone channel (Telegram now, others later), in the language of his profile.
// One table, no markup in it: a renderer (render.mjs for Telegram HTML) puts the layout around these texts, so a second
// channel is another renderer over the same keys. `{name}` is filled from the vars of t(). No imports: the hooks module
// (tools/hooks/telegram.ts) and Node (notify.mjs, inbox.mjs) both load this file.
//
// The language is the profile's own line (<config dir>/makarasty/profile.md): "Language: Russian" gives ru, anything else
// or no profile gives en. Add a language: one more object below, and one test in notify-selftest for it.

export const STRINGS = {
  en: {
    hidden: '[hidden]',
    more: '❔ Details',
    kindAsk: 'question', kindChoice: 'yes/no', kindCard: 'card',
    ageMin: '{n} min', ageH: '{n} h',
    cardQuestion: 'Start "{title}"?',
    moreQuestions: '{n} more in the same window: answer in the inbox on the computer',
    cardNote: 'start it from the inbox on the computer',
    // notify.mjs: the finish line and its kin
    setupHint: 'Telegram is not connected yet: ask any chat "set up notifications" (it runs "notify.mjs setup")',
    late: 'not delivered in time, finished at {time} UTC',
    elapsedHM: '{h} h {m} min', elapsedM: '{m} min',
    paused: 'paused: background jobs are still running ({n})',
    resumed: 'the chat was restarted',
    done: 'done', doneQ: 'done, with a question for you',
    failed: 'failed on an error{elapsed}: {error}. Open the chat to continue.',
    unknown: 'unknown',
    waiting: 'waiting for you{elapsed}: {message}',
    connectedTitle: 'Claude Code on {host} is connected.',
    connectedBody: 'Chat questions with buttons and the results you asked for will arrive here. Write in plain words what you need.',
    testLine: 'check from {host}: Telegram works',
    // telegram.ts: taps, replies, commands
    ackClosed: 'Already closed',
    ackExplain: 'Writing the explanation...',
    ackAnsweredApp: 'Already answered in the app',
    ackTaken: 'Got it, sending to the chat',
    outAnsweredApp: 'answered in the app',
    outAnsweredPc: 'answered on the computer',
    outClosed: 'closed',
    outStale: 'out of date',
    outAlready: '{pick} (already answered)',
    outNotSent: '{pick} (not sent: {why})',
    outFailed: 'failed',
    textOnly: 'I only understand text: write it in words.',
    pictureNote: ' (I cannot see a picture or file, only its caption)',
    helpTitle: 'What the bot does',
    helpQuestions: 'chat questions arrive here: tap a button or reply to the message in your own words',
    helpMore: '"❔ Details" explains the question; a reply that is a question goes to the inbox',
    helpAny: 'write anything in plain words: a question, a task, "send a screenshot of the desktop", "add a task to Obsidian", "start a chat in project X"; the answer, a picture, a video or a voice note comes back here',
    helpNote: 'Telegram keeps messages for a bot for a day: if the computer is off longer, the old ones are lost.',
    statusWaiting: 'Waiting for an answer: {n}',
    statusCard: 'card "{title}"',
    inboxUp: 'the inbox is running on the computer',
    inboxDown: 'the inbox is not running: a background inbox will answer messages',
    explainHint: 'Not clear? Reply to this message with a question.',
    explainNone: 'No explanation: the chat has left the inbox. Reply to this message with a question.',
    offline: 'The computer was unreachable for {h} h: what you wrote earlier than a day ago, Telegram did not keep.',
    turnFailed: 'Could not answer: the inbox turn was interrupted. Write again.',
    // inbox.mjs: the headless turn
    headlessFailed: 'I could not answer in time: the background inbox did not finish in 5 minutes. Write again or open the inbox on the computer.',
  },
  ru: {
    hidden: '[скрыто]',
    more: '❔ Подробнее',
    kindAsk: 'вопрос', kindChoice: 'да/нет', kindCard: 'карточка',
    ageMin: '{n} мин', ageH: '{n} ч',
    cardQuestion: 'Запустить «{title}»?',
    moreQuestions: 'ещё {n} в том же окне: ответ в инбоксе на компьютере',
    cardNote: 'запуск из инбокса на компьютере',
    setupHint: 'Telegram is not connected yet: ask any chat "настрой уведомления" (it runs "notify.mjs setup")',
    late: 'не дошло вовремя, готово было {time} UTC',
    elapsedHM: '{h} ч {m} мин', elapsedM: '{m} мин',
    paused: 'пауза: ещё идут фоновые задачи ({n})',
    resumed: 'чат перезапускался',
    done: 'готово', doneQ: 'готово, есть вопрос к тебе',
    failed: 'упал на ошибке{elapsed}: {error}. Открой чат, чтобы продолжить.',
    unknown: 'неизвестно',
    waiting: 'ждёт тебя{elapsed}: {message}',
    connectedTitle: 'Claude Code на {host} подключён.',
    connectedBody: 'Сюда придут вопросы чатов с кнопками и итоги, о которых ты просил. Пиши обычным текстом, что нужно.',
    testLine: 'проверка с {host}: Telegram работает',
    ackClosed: 'Уже закрыто',
    ackExplain: 'Пишу пояснение…',
    ackAnsweredApp: 'Уже отвечено в приложении',
    ackTaken: 'Принято, отправляю в чат',
    outAnsweredApp: 'отвечено в приложении',
    outAnsweredPc: 'отвечено на компьютере',
    outClosed: 'закрыто',
    outStale: 'устарело',
    outAlready: '{pick} (уже было отвечено)',
    outNotSent: '{pick} (не отправлено: {why})',
    outFailed: 'не получилось',
    textOnly: 'Понимаю только текст: напиши словами.',
    pictureNote: ' (картинку или файл я не вижу, только подпись)',
    helpTitle: 'Что умеет бот',
    helpQuestions: 'вопросы чатов приходят сюда: нажми кнопку или ответь на сообщение своими словами',
    helpMore: '«❔ Подробнее» — пояснение к вопросу; ответ вопросом на сообщение — спросит инбокс',
    helpAny: 'пиши что угодно обычным текстом: вопрос, задачу, «скинь скриншот экрана», «создай задачу в Obsidian», «запусти чат в проекте X» — ответ, картинка, видео или голосовое придут сюда',
    helpNote: 'Telegram хранит сообщения для бота сутки: если компьютер выключен дольше, старое пропадёт.',
    statusWaiting: 'Ждут ответа: {n}',
    statusCard: 'карточка «{title}»',
    inboxUp: 'инбокс на компьютере работает',
    inboxDown: 'инбокс не запущен: на сообщения ответит фоновый инбокс',
    explainHint: 'Непонятно — ответь на это сообщение вопросом.',
    explainNone: 'Пояснения нет: чат ушёл из инбокса. Ответь на это сообщение вопросом.',
    offline: 'Компьютер был недоступен {h} ч: что ты писал раньше, чем за сутки, Telegram не сохранил.',
    turnFailed: 'Не получилось ответить: ход в инбоксе прервался. Напиши ещё раз.',
    headlessFailed: 'Не успел ответить: фоновый инбокс не закончил за 5 минут. Напиши ещё раз или открой инбокс на компьютере.',
  },
}

/** 'ru' when the profile's `Language:` line names Russian ("Language: Russian, plain and short", "Язык: русский"), else 'en'. */
export function langOf(/** @type {string | undefined} */ profileText) {
  const v = /(?:language|язык)\s*:\s*([^\n.,;]*)/i.exec(String(profileText ?? ''))?.[1] ?? ''
  return /russian|русск|^\s*ru\s*$/i.test(v) ? 'ru' : 'en'
}

/** The text for `key` in `lang`, `{name}` filled from `vars`; a language or key that is missing falls back to en, then to the key. */
export function t(/** @type {string | undefined} */ lang, /** @type {string} */ key, /** @type {Record<string, string | number>} */ vars = {}) {
  const table = /** @type {Record<string, Record<string, string>>} */ (STRINGS)
  const s = table[lang ?? 'en']?.[key] ?? table.en[key] ?? key
  return s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all))
}
