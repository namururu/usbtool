# Mwongozo wa AI: Portable Codex Agent API

Wewe ni wakala wa AI unaotaka kutumia Portable Codex GUI bila kubonyeza vitufe vya GUI. Tumia API ya JSON. Usitumie automation ya kubofya ukurasa kama huna sababu maalum.

## Anuani ya msingi

Kwenye kompyuta ile ile:

```text
http://127.0.0.1:41731
```

Kwenye LAN:

```text
http://<IP-ya-kompyuta>:41731
```

Kama uko LAN, kwanza fungua ukurasa kwenye browser na ingiza password ya LAN. Baada ya hapo cookie ya password itatumika kwa API pia.

## Anza hapa

Soma maelezo ya API:

```http
GET /api/agent
```

Hii hurudisha endpoints na mifano. Ikiwa hujui cha kufanya, soma endpoint hii kwanza.

## Kuendesha Codex

Tuma kazi mpya:

```http
POST /api/agent/run
Content-Type: application/json
```

Mfano wa body:

```json
{
  "prompt": "Chunguza folda hii na andika muhtasari mfupi.",
  "permission": "workspace-write",
  "resume": true,
  "japanese": true,
  "autonomous": true
}
```

Jibu litakuwa na `id`, `statusUrl`, `eventsUrl`, na `stopUrl`.

## Kuangalia hali ya kazi

Tumia polling:

```http
GET /api/agent/jobs/<id>
```

Au tumia Server-Sent Events:

```http
GET /api/agent/jobs/<id>/events
```

Events muhimu:

- `meta`: taarifa za workspace, permission, mode, command
- `stdout`: majibu yanayoonekana kutoka Codex
- `stderr`: makosa au taarifa za CLI
- `artifacts`: faili mpya zilizokusanywa
- `exit`: mwisho wa kazi

## Kusimamisha kazi

```http
POST /api/agent/jobs/<id>/stop
```

Tumia hii kama kazi imekwama au mtumiaji ameomba kusimamisha.

## Faili na matokeo

Orodha ya artifacts:

```http
GET /api/agent/files/artifacts
```

Orodha ya picha:

```http
GET /api/agent/files/images
```

Orodha ya uploads:

```http
GET /api/agent/files/uploads
```

Kila item ina `name`, `url`, `path`, `size`, na `mtimeMs`. Tumia `url` kupakua kutoka browser/API. Usidhani kwamba client yako inaweza kusoma `path` moja kwa moja kama iko kwenye mashine nyingine.

## Kusawazisha maonyesho ya chat

Kama unataka kuongeza ujumbe kwenye GUI iliyosawazishwa:

```http
POST /api/agent/ui-log
Content-Type: application/json
```

Mfano:

```json
{
  "type": "text",
  "kind": "system",
  "text": "AI imeanza kazi.",
  "source": "my-agent"
}
```

Kufuta log ya GUI:

```http
POST /api/agent/ui-log/clear
```

## Kanuni za tabia

- Usibonyeze GUI kama API inatosha.
- Kwanza tumia `GET /api/agent/status` kujua kama Codex ipo tayari.
- Kwa kazi ndefu, tumia `eventsUrl` badala ya kusubiri response moja kubwa.
- Baada ya `exit`, angalia `job.exit.status` na `job.exit.code`.
- Kama kuna artifacts, toa links za `url` kwa mtumiaji.
- Usitumie `bypass` bila sababu nzuri au bila mtumiaji kujua.
- Kwenye LAN, chukulia API hii kama remote control yenye nguvu. Usishiriki password na watu wasioaminika.

