# Личный бюджет

Финальная версия с обычной авторизацией через Supabase.

Что важно:
- пользователь видит только экран входа: email, пароль, кнопка «Войти»;
- регистрация в интерфейсе отключена;
- Supabase URL и publishable key хранятся в `cloud-config.js`;
- после входа сессия сохраняется в браузере;
- при следующем открытии сайт сам проверяет вход и загружает данные;
- в настройках отображаются статус аккаунта и кнопка выхода;
- технические настройки спрятаны в «Режим разработчика».

Перед загрузкой на GitHub Pages проверь `cloud-config.js`:

```js
window.BUDGET_SUPABASE_CONFIG = {
  url: 'https://gzipgbtlamynjwlaefku.supabase.co',
  key: 'PASTE_YOUR_PUBLISHABLE_KEY_HERE'
};
```

В поле `key` нужно вставить Supabase publishable/anon key. Secret/service_role key использовать нельзя.

