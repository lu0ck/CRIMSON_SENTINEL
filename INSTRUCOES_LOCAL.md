# Crimson Sentinel - Guia de Instalação Local

Este guia explica como rodar o Crimson Sentinel no seu PC com **CachyOS**.

## 1. Pré-requisitos

Certifique-se de ter o **Node.js** e o **npm** instalados:
```bash
sudo pacman -S nodejs npm
```

## 2. Instalação

1.  Baixe os arquivos do projeto para uma pasta.
2.  Abra o terminal na pasta do projeto.
3.  Instale as dependências:
    ```bash
    npm install
    ```

## 3. Configuração

1.  (Opcional) Crie um arquivo `.env` na raiz do projeto (use o `.env.example` como base).
2.  **Novo**: Você pode configurar sua **GEMINI_API_KEY** e canais de notificação (Discord, Telegram, Gmail) diretamente dentro do aplicativo, na aba **CONFIG** do seu perfil. Isso evita a necessidade de editar arquivos de texto.
3.  Você pode obter uma chave Gemini gratuitamente em [Google AI Studio](https://aistudio.google.com/app/apikey).

## 5. Compartilhando com Amigos

O sistema agora suporta múltiplos **Perfis de Operador**.
- Cada amigo pode criar seu próprio perfil ao acessar o app.
- As configurações de notificação (Discord, Telegram, Gmail) são salvas individualmente por perfil.
- As listas e produtos adicionados por um perfil não aparecem para os outros, garantindo privacidade.

Para disponibilizar para seus amigos na sua rede local:
1.  Descubra seu IP local (ex: `192.168.1.10`).
2.  Seus amigos podem acessar `http://192.168.1.10:3000` no navegador deles.
3.  Certifique-se de que o firewall do seu CachyOS permite conexões na porta 3000.

---

## Sobre a API do Gemini

### Custos
- **Plano Gratuito**: Atualmente, o modelo `gemini-1.5-flash` (ou similares) possui um nível gratuito generoso (cerca de 15 requisições por minuto e 1 milhão de tokens por dia). Para um uso pessoal de rastreamento de preços, o plano gratuito é mais que suficiente.
- **Plano Pago**: Se você exceder os limites, pode optar pelo faturamento por uso (Pay-as-you-go).

### Por que o "Scrape" pode falhar no Preview?
1.  **Restrições de Rede**: O ambiente de visualização do AI Studio pode bloquear acessos a certos sites externos por segurança.
2.  **Bloqueio de Bots**: Sites como Amazon e Mercado Livre possuem proteções contra scrapers. No seu PC local, o comportamento pode ser diferente, mas para maior eficiência, o sistema usa o Gemini para "ler" o site via `urlContext`.
3.  **API Key**: Verifique se a chave API está configurada corretamente no seu ambiente local.

## 6. Transformando em App Desktop (Electron)

Você pode "fechar" o Crimson Sentinel em um aplicativo executável para rodar no seu PC sem precisar abrir o navegador manualmente.

### Para rodar em modo App (Desenvolvimento):
```bash
npm run electron:dev
```

### Para gerar o instalador (Build):
```bash
npm run electron:build
```
Isso criará uma pasta `release` com o instalador para o seu sistema (AppImage, .deb ou .rpm para CachyOS/Linux).

## 7. Disponibilizando no GitHub

Para que seus amigos baixem e usem na casa deles:
1.  Crie um repositório no GitHub.
2.  Suba todos os arquivos do projeto (exceto `node_modules`, `dist` e `release`).
3.  Seus amigos podem baixar o código, rodar `npm install` e `npm run electron:build` para gerar o próprio app deles.
4.  **Importante**: Cada amigo precisará da sua própria `GEMINI_API_KEY` configurada no arquivo `.env` da casa deles.

---

### Dica de Segurança
Nunca suba o arquivo `.env` com sua chave real para o GitHub. O projeto já inclui um `.gitignore` para evitar isso. Seus amigos devem criar o próprio `.env` baseando-se no `.env.example`.
