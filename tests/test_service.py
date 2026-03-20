import unittest

from botspace_crm_integration import (
    BotSpaceCRMIntegration,
    CRMContact,
    InMemoryCRM,
    InMemoryDedupStore,
    OpenAICompletion,
    PromptPolicy,
)


class FakeOpenAIClient:
    def __init__(self, completion: OpenAICompletion) -> None:
        self.completion = completion
        self.prompts = []

    def complete(self, prompt):
        self.prompts.append(prompt)
        return self.completion


class BotSpaceCRMIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.crm = InMemoryCRM()
        self.crm.contacts["user-123"] = CRMContact(
            contact_id="contact-123",
            external_user_id="user-123",
            name="Riley Customer",
            status="active",
            owner="alex@example.com",
            last_ticket="TCK-42",
            tags=["vip", "renewal"],
        )
        self.policy = PromptPolicy(
            allowed_actions=["answer_question", "summarize_context", "offer_handoff"],
            fallback_policy="If the answer is uncertain, apologize briefly and offer a human handoff.",
            confidence_threshold=0.75,
        )

    def test_happy_path_uses_existing_contact_and_writes_transcript(self) -> None:
        openai_client = FakeOpenAIClient(
            OpenAICompletion(
                reply="Your renewal is in progress and Alex owns the account.",
                summary="Customer asked for status. Shared active status, owner, and renewal context.",
                confidence=0.91,
            )
        )
        integration = BotSpaceCRMIntegration(
            crm=self.crm,
            openai_client=openai_client,
            dedup_store=InMemoryDedupStore(),
            policy=self.policy,
        )

        result = integration.handle_botspace_message(
            {
                "webhook_event_id": "evt-1",
                "message_id": "msg-1",
                "message": "Can you tell me the latest on my renewal?",
                "user": {"id": "user-123", "name": "Riley Customer"},
            }
        )

        self.assertEqual(result["status"], "ok")
        self.assertFalse(result["escalated"])
        self.assertEqual(result["contact_id"], "contact-123")
        self.assertEqual(len(self.crm.activity_notes), 1)
        self.assertEqual(self.crm.activity_notes[0]["transcript_summary"], openai_client.completion.summary)
        self.assertEqual(len(self.crm.escalations), 0)
        self.assertEqual(
            openai_client.prompts[0],
            {
                "user_message": "Can you tell me the latest on my renewal?",
                "crm_context": {
                    "status": "active",
                    "owner": "alex@example.com",
                    "last_ticket": "TCK-42",
                    "tags": ["vip", "renewal"],
                },
                "allowed_actions": ["answer_question", "summarize_context", "offer_handoff"],
                "fallback_policy": "If the answer is uncertain, apologize briefly and offer a human handoff.",
            },
        )

    def test_creates_new_lead_stub_when_contact_is_missing(self) -> None:
        openai_client = FakeOpenAIClient(
            OpenAICompletion(
                reply="Thanks for reaching out — I've created your inquiry and can help from here.",
                summary="Created a lead stub and acknowledged the inbound request.",
                confidence=0.88,
            )
        )
        integration = BotSpaceCRMIntegration(
            crm=self.crm,
            openai_client=openai_client,
            dedup_store=InMemoryDedupStore(),
            policy=self.policy,
        )

        result = integration.handle_botspace_message(
            {
                "message_id": "msg-2",
                "message": "I need help getting started.",
                "user": {"id": "new-user", "name": "Jordan Prospect"},
            }
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["contact_id"], "lead-2")
        self.assertIn("new-user", self.crm.contacts)
        self.assertTrue(self.crm.contacts["new-user"].is_lead_stub)

    def test_deduplicates_messages_and_escalates_low_confidence_responses(self) -> None:
        openai_client = FakeOpenAIClient(
            OpenAICompletion(
                reply="I want to make sure you get the right help, so I'm handing this to a specialist.",
                summary="Could not answer confidently and initiated human handoff.",
                confidence=0.40,
            )
        )
        dedup_store = InMemoryDedupStore()
        integration = BotSpaceCRMIntegration(
            crm=self.crm,
            openai_client=openai_client,
            dedup_store=dedup_store,
            policy=self.policy,
        )
        event = {
            "webhook_event_id": "evt-3",
            "message_id": "msg-3",
            "message": "Can you override my contract terms?",
            "user": {"id": "user-123", "name": "Riley Customer"},
        }

        first_result = integration.handle_botspace_message(event)
        second_result = integration.handle_botspace_message(event)

        self.assertTrue(first_result["escalated"])
        self.assertEqual(second_result["status"], "duplicate_ignored")
        self.assertEqual(len(self.crm.escalations), 1)
        self.assertEqual(len(self.crm.activity_notes), 1)
        self.assertEqual(len(openai_client.prompts), 1)


if __name__ == "__main__":
    unittest.main()
