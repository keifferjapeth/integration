from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(slots=True)
class CRMContact:
    contact_id: str
    external_user_id: str
    name: str
    status: str = "new"
    owner: str = "unassigned"
    last_ticket: str | None = None
    tags: list[str] = field(default_factory=list)
    is_lead_stub: bool = False


@dataclass(slots=True)
class CRMContext:
    status: str
    owner: str
    last_ticket: str | None
    tags: list[str]


@dataclass(slots=True)
class PromptPolicy:
    allowed_actions: list[str]
    fallback_policy: str
    confidence_threshold: float


@dataclass(slots=True)
class OpenAICompletion:
    reply: str
    summary: str
    confidence: float


class CRMClient(Protocol):
    def find_contact_by_external_user_id(self, external_user_id: str) -> CRMContact | None: ...

    def create_lead_stub(self, *, external_user_id: str, name: str) -> CRMContact: ...

    def fetch_context(self, contact_id: str) -> CRMContext: ...

    def store_activity_note(
        self,
        *,
        contact_id: str,
        message_id: str,
        transcript_summary: str,
        user_message: str,
        assistant_reply: str,
        escalated: bool,
    ) -> None: ...

    def escalate_to_human(self, *, contact_id: str, reason: str, source_message_id: str) -> None: ...


class OpenAIClient(Protocol):
    def complete(self, prompt: dict[str, Any]) -> OpenAICompletion: ...


class DedupStore(Protocol):
    def seen(self, event_id: str) -> bool: ...

    def mark(self, event_id: str) -> None: ...


class InMemoryDedupStore:
    def __init__(self) -> None:
        self._event_ids: set[str] = set()

    def seen(self, event_id: str) -> bool:
        return event_id in self._event_ids

    def mark(self, event_id: str) -> None:
        self._event_ids.add(event_id)


class InMemoryCRM:
    def __init__(self) -> None:
        self.contacts: dict[str, CRMContact] = {}
        self.activity_notes: list[dict[str, Any]] = []
        self.escalations: list[dict[str, Any]] = []
        self.created_leads: list[str] = []

    def find_contact_by_external_user_id(self, external_user_id: str) -> CRMContact | None:
        return self.contacts.get(external_user_id)

    def create_lead_stub(self, *, external_user_id: str, name: str) -> CRMContact:
        contact = CRMContact(
            contact_id=f"lead-{len(self.contacts) + 1}",
            external_user_id=external_user_id,
            name=name,
            is_lead_stub=True,
            tags=["lead", "botspace"],
        )
        self.contacts[external_user_id] = contact
        self.created_leads.append(contact.contact_id)
        return contact

    def fetch_context(self, contact_id: str) -> CRMContext:
        contact = next(contact for contact in self.contacts.values() if contact.contact_id == contact_id)
        return CRMContext(
            status=contact.status,
            owner=contact.owner,
            last_ticket=contact.last_ticket,
            tags=list(contact.tags),
        )

    def store_activity_note(
        self,
        *,
        contact_id: str,
        message_id: str,
        transcript_summary: str,
        user_message: str,
        assistant_reply: str,
        escalated: bool,
    ) -> None:
        self.activity_notes.append(
            {
                "contact_id": contact_id,
                "message_id": message_id,
                "transcript_summary": transcript_summary,
                "user_message": user_message,
                "assistant_reply": assistant_reply,
                "escalated": escalated,
            }
        )

    def escalate_to_human(self, *, contact_id: str, reason: str, source_message_id: str) -> None:
        self.escalations.append(
            {
                "contact_id": contact_id,
                "reason": reason,
                "source_message_id": source_message_id,
            }
        )


class BotSpaceCRMIntegration:
    def __init__(
        self,
        *,
        crm: CRMClient,
        openai_client: OpenAIClient,
        dedup_store: DedupStore,
        policy: PromptPolicy,
    ) -> None:
        self.crm = crm
        self.openai_client = openai_client
        self.dedup_store = dedup_store
        self.policy = policy

    def handle_botspace_message(self, event: dict[str, Any]) -> dict[str, Any]:
        dedup_key = self._dedup_key(event)
        if self.dedup_store.seen(dedup_key):
            return {
                "status": "duplicate_ignored",
                "message_id": event["message_id"],
                "webhook_event_id": event.get("webhook_event_id"),
            }

        self.dedup_store.mark(dedup_key)

        user = event["user"]
        message_id = event["message_id"]
        user_message = event["message"]

        contact = self.crm.find_contact_by_external_user_id(user["id"])
        if contact is None:
            contact = self.crm.create_lead_stub(external_user_id=user["id"], name=user["name"])

        crm_context = self.crm.fetch_context(contact.contact_id)
        prompt = self._build_prompt(user_message=user_message, crm_context=crm_context)
        completion = self.openai_client.complete(prompt)

        escalated = completion.confidence < self.policy.confidence_threshold
        if escalated:
            self.crm.escalate_to_human(
                contact_id=contact.contact_id,
                reason=(
                    f"Confidence {completion.confidence:.2f} below threshold "
                    f"{self.policy.confidence_threshold:.2f}"
                ),
                source_message_id=message_id,
            )

        self.crm.store_activity_note(
            contact_id=contact.contact_id,
            message_id=message_id,
            transcript_summary=completion.summary,
            user_message=user_message,
            assistant_reply=completion.reply,
            escalated=escalated,
        )

        return {
            "status": "ok",
            "message_id": message_id,
            "contact_id": contact.contact_id,
            "reply": completion.reply,
            "escalated": escalated,
            "confidence": completion.confidence,
        }

    def _dedup_key(self, event: dict[str, Any]) -> str:
        message_id = event.get("message_id")
        webhook_event_id = event.get("webhook_event_id")
        if message_id:
            return f"message:{message_id}"
        if webhook_event_id:
            return f"webhook:{webhook_event_id}"
        raise ValueError("bot.space event must include message_id or webhook_event_id for deduplication")

    def _build_prompt(self, *, user_message: str, crm_context: CRMContext) -> dict[str, Any]:
        return {
            "user_message": user_message,
            "crm_context": {
                "status": crm_context.status,
                "owner": crm_context.owner,
                "last_ticket": crm_context.last_ticket,
                "tags": crm_context.tags,
            },
            "allowed_actions": self.policy.allowed_actions,
            "fallback_policy": self.policy.fallback_policy,
        }
