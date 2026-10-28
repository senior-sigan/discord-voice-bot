import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { PersonProfile, ProfileStore } from "../agent/profiles.ts";
import { PROFILE_SECTIONS } from "../agent/profiles.ts";
import { textResult } from "./types.ts";

const parameters = Type.Object(
  {
    person: Type.String({ minLength: 1, maxLength: 100, description: "Discord userId, имя или алиас участника" }),
  },
  { additionalProperties: false },
);

export function createGetProfileTool(profiles: ProfileStore): AgentTool<typeof parameters> {
  const catalog = profiles.profiles
    .map(({ name, user_id, aliases }) => `${name} (${user_id})${aliases.length ? ` [${aliases.join(", ")}]` : ""}`)
    .join(", ");
  return {
    name: "get_person_profile",
    label: "Посмотреть профиль участника",
    description: `Возвращает структурированный профиль участника: алиасы, игры, работа, жизненные истории, текущие сложности, интересы, медиа и планы. Сохранённые профили (алиасы в квадратных скобках): ${catalog || "нет"}. Ищи по имени, алиасу или userId. Если подходят несколько участников, уточни, о ком речь. Используй только когда это помогает текущему вопросу; не притягивай детали профиля к разговору без причины.`,
    parameters,
    async execute(_toolCallId, args) {
      const matches = profiles.find(args.person).map(profileView);
      return textResult({ count: matches.length, profiles: matches });
    },
  };
}

function profileView(profile: PersonProfile) {
  return {
    user_id: profile.user_id,
    name: profile.name,
    aliases: profile.aliases,
    updated_at: profile.updated_at,
    source_from: profile.source_from,
    source_to: profile.source_to,
    sections: Object.fromEntries(
      PROFILE_SECTIONS.map((section) => [
        section,
        profile.sections[section].map(({ summary, status, last_seen_at }) => ({ summary, status, last_seen_at })),
      ]),
    ),
  };
}
