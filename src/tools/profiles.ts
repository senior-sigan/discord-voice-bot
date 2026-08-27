import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { PersonProfile, ProfileStore } from "../agent/profiles.js";
import { PROFILE_SECTIONS } from "../agent/profiles.js";
import { textResult } from "./types.js";

const parameters = Type.Object(
  {
    person: Type.String({ minLength: 1, maxLength: 100, description: "Discord userId или имя участника" }),
  },
  { additionalProperties: false },
);

export function createGetProfileTool(profiles: ProfileStore): AgentTool<typeof parameters> {
  const catalog = profiles.profiles.map(({ name, user_id }) => `${name} (${user_id})`).join(", ");
  return {
    name: "get_person_profile",
    label: "Посмотреть профиль участника",
    description: `Возвращает структурированный профиль участника: игры, работа, жизненные истории, текущие сложности, интересы, медиа и планы. Сохранённые профили: ${catalog || "нет"}. Если имя произнесено иначе, выбери из списка наиболее вероятного участника и передай его точное имя или userId. Используй только когда это помогает текущему вопросу; не притягивай детали профиля к разговору без причины.`,
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
