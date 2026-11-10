
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "api": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_invitation":
{ Args: { "p_token": string }; Returns: Database["api"]['CompositeTypes']["membership_row"]
                          SetofOptions: {
        from: "*"
        to: "membership_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"acknowledge_incident_notice":
{ Args: { "p_id": string }; Returns: undefined
                           },
"add_custom_domain":
{ Args: { "p_hostname": string,"p_idempotency_key": string,"p_location_id": string,"p_org_id": string }; Returns: Database["api"]['CompositeTypes']["custom_domain_row"]
                          SetofOptions: {
        from: "*"
        to: "custom_domain_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"add_guest_contact":
{ Args: { "p_channel": string,"p_guest_id": string,"p_idempotency_key": string,"p_value": string }; Returns: string
                           },
"advance_journey":
{ Args: { "p_expected_version": number,"p_idempotency_key": string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"apply_billing_event":
{ Args: { "p_created": string,"p_customer_id": string,"p_org_id": string,"p_period_end": string,"p_price_id": string,"p_quantity": number,"p_status": string,"p_subscription_id": string,"p_type": string }; Returns: string
                           },
"apply_bundle_grant":
{ Args: { "p_created": string,"p_invoice_id": string,"p_subscription_id": string }; Returns: string
                           },
"apply_credit_topup":
{ Args: { "p_amount_minor": number,"p_currency": string,"p_org_id": string,"p_session_id": string }; Returns: string
                           },
"apply_delivery_status":
{ Args: { "p_error_code"?: string,"p_org_id": string,"p_provider": string,"p_provider_message_id": string,"p_status": string }; Returns: boolean
                           },
"apply_industry_template":
{ Args: { "p_idempotency_key": string,"p_location_id": string,"p_template_key": string }; Returns: Database["api"]['CompositeTypes']["template_result"]
                          SetofOptions: {
        from: "*"
        to: "template_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"apply_payment_event":
{ Args: { "p_amount_minor": number,"p_customer_id": string,"p_meta_org": string,"p_object_id": string,"p_org_id": string,"p_payment_method_id": string,"p_provider": string,"p_type": string }; Returns: string
                           },
"apply_platform_sms_event":
{ Args: { "p_error_code"?: string,"p_kind": string,"p_phone"?: string,"p_provider_message_id"?: string,"p_status"?: string }; Returns: boolean
                           },
"apply_provider_price":
{ Args: { "p_currency": string,"p_notification_id": string,"p_org_id": string,"p_price": number }; Returns: undefined
                           },
"approve_guest_notice":
{ Args: { "p_id": string }; Returns: Database["api"]['CompositeTypes']["guest_notice"]
                          SetofOptions: {
        from: "*"
        to: "guest_notice"
        isOneToOne: true
        isSetofReturn: false
      } },
"ask_analytics_reserve":
{ Args: { "p_org_id": string,"p_question": string }; Returns: number
                           },
"assign_visit":
{ Args: { "p_counter_id": string,"p_expected_version": number,"p_idempotency_key": string,"p_staff_user_id": string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"attach_form":
{ Args: { "p_channel"?: string,"p_form_id": string,"p_org_id": string,"p_target_ids": (string)[] }; Returns: number
                           },
"attach_payment_intent":
{ Args: { "p_intent_id": string,"p_payment_id": string,"p_setup_intent_id": string }; Returns: undefined
                           },
"begin_data_export":
{ Args: { "p_format": string,"p_idempotency_key": string }; Returns: Database["api"]['CompositeTypes']["export_ticket"]
                          SetofOptions: {
        from: "*"
        to: "export_ticket"
        isOneToOne: true
        isSetofReturn: false
      } },
"begin_integration_connect":
{ Args: { "p_channel": string,"p_org_id": string }; Returns: string
                           },
"begin_payment":
{ Args: { "p_idempotency_key": string,"p_provider": string,"p_token": string }; Returns: {
              "amount_minor": number,"currency": string,"intent_id": string,"kind": string,"org_id": string,"payment_id": string,"ref_id": string
            }[]
                           },
"begin_pos_payment":
{ Args: { "p_provider": string,"p_token": string }; Returns: {
              "amount_minor": number,"cancel_cutoff_hours": number,"currency": string,"intent_id": string,"kind": string,"org_id": string,"payment_id": string,"ref_id": string,"release_after": string
            }[]
                           },
"begin_pos_payment_by_code":
{ Args: { "p_code": string,"p_provider": string }; Returns: {
              "amount_minor": number,"cancel_cutoff_hours": number,"currency": string,"intent_id": string,"kind": string,"org_id": string,"payment_id": string,"ref_id": string,"release_after": string
            }[]
                           },
"billing_session_info":
{ Args: { "p_interval"?: string,"p_org_id": string }; Returns: {
              "customer_id": string,"price_id": string,"quantity": number,"subscription_id": string
            }[]
                           },
"block_from_visit":
{ Args: { "p_expires_at": string,"p_idempotency_key": string,"p_reason": string,"p_visit_id": string }; Returns: string
                           },
"block_time_bulk":
{ Args: { "p_idempotency_key": string,"p_location_id": string,"p_ranges": (unknown)[],"p_reason": string,"p_resource_ids": (string)[] }; Returns: Database["api"]['CompositeTypes']["bulk_block_result"]
                          SetofOptions: {
        from: "*"
        to: "bulk_block_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"book_appointment":
{ Args: { "p_email": string,"p_idempotency_key": string,"p_join_pass"?: string,"p_locale": string,"p_location_slug": string,"p_name": string,"p_party_size": number,"p_phone_e164": string,"p_service_id": string,"p_slot_start": string }; Returns: Database["api"]['CompositeTypes']["booking_result"]
                          SetofOptions: {
        from: "*"
        to: "booking_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"book_event_seats":
{ Args: { "p_email": string,"p_event_id": string,"p_idempotency_key": string,"p_name": string,"p_party_size": number,"p_phone_e164": string }; Returns: Database["api"]['CompositeTypes']["booking_result"]
                          SetofOptions: {
        from: "*"
        to: "booking_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"calendar_feed_events":
{ Args: { "p_token": string }; Returns: Database["api"]['CompositeTypes']["appointment_row"][]
                          SetofOptions: {
        from: "*"
        to: "appointment_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"call_next":
{ Args: { "p_counter_id": string,"p_idempotency_key": string,"p_queue_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"cancel_event":
{ Args: { "p_event_id": string,"p_idempotency_key": string,"p_reason": string }; Returns: Database["api"]['CompositeTypes']["event_row"]
                          SetofOptions: {
        from: "*"
        to: "event_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"cancel_org_deletion":
{ Args: { "p_org_id": string }; Returns: undefined
                           },
"cancel_series_from":
{ Args: { "p_from": string,"p_idempotency_key": string,"p_series_id": string }; Returns: number
                           },
"claim_billing_jobs":
{ Args: { "p_lease_seconds": number,"p_limit": number }; Returns: {
              "attempts": number,"id": string,"org_id": string,"quantity": number,"stripe_subscription_id": string
            }[]
                           },
"claim_integration_jobs":
{ Args: { "p_lease_seconds": number,"p_limit": number }; Returns: Database["api"]['CompositeTypes']["integration_job"][]
                          SetofOptions: {
        from: "*"
        to: "integration_job"
        isOneToOne: false
        isSetofReturn: true
      } },
"claim_outbox":
{ Args: { "p_lease_seconds": number,"p_limit": number }; Returns: Database["api"]['CompositeTypes']["outbox_job"][]
                          SetofOptions: {
        from: "*"
        to: "outbox_job"
        isOneToOne: false
        isSetofReturn: true
      } },
"claim_payment_jobs":
{ Args: { "p_lease_seconds": number,"p_limit": number }; Returns: Database["api"]['CompositeTypes']["payment_job"][]
                          SetofOptions: {
        from: "*"
        to: "payment_job"
        isOneToOne: false
        isSetofReturn: true
      } },
"claim_webhook_deliveries":
{ Args: { "p_lease_seconds": number,"p_limit": number }; Returns: Database["api"]['CompositeTypes']["webhook_job"][]
                          SetofOptions: {
        from: "*"
        to: "webhook_job"
        isOneToOne: false
        isSetofReturn: true
      } },
"consume_integration_state":
{ Args: { "p_state": string,"p_user_id": string }; Returns: Database["api"]['CompositeTypes']["integration_credentials"]
                          SetofOptions: {
        from: "*"
        to: "integration_credentials"
        isOneToOne: true
        isSetofReturn: false
      } },
"contact_support":
{ Args: { "p_context"?: Json,"p_message": string,"p_org_id": string,"p_subject": string }; Returns: string
                           },
"correct_visit_times":
{ Args: { "p_called_at": string,"p_expected_version": number,"p_finished_at": string,"p_idempotency_key": string,"p_reason": string,"p_serving_at": string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"counter_display_snapshot":
{ Args: Record<PropertyKey, never>; Returns: Database["api"]['CompositeTypes']["counter_snapshot"]
                          SetofOptions: {
        from: "*"
        to: "counter_snapshot"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_api_key":
{ Args: { "p_expires_at": string,"p_idempotency_key": string,"p_location_ids": (string)[],"p_name": string,"p_org_id": string,"p_scopes": (string)[] }; Returns: Database["api"]['CompositeTypes']["api_key_created"]
                          SetofOptions: {
        from: "*"
        to: "api_key_created"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_appointment_series":
{ Args: { "p_count": number,"p_dry_run"?: boolean,"p_email": string,"p_first_date": string,"p_idempotency_key": string,"p_interval_weeks": number,"p_local_time": string,"p_location_id": string,"p_name": string,"p_phone_e164": string,"p_service_id": string,"p_staff_user_id": string,"p_until": string }; Returns: Database["api"]['CompositeTypes']["appointment_series_result"]
                          SetofOptions: {
        from: "*"
        to: "appointment_series_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_calendar_feed":
{ Args: { "p_include_guest_names": boolean }; Returns: Database["api"]['CompositeTypes']["calendar_feed_created"]
                          SetofOptions: {
        from: "*"
        to: "calendar_feed_created"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_invitation":
{ Args: { "p_display_name": string,"p_email": string,"p_idempotency_key": string,"p_location_ids": (string)[],"p_org_id": string,"p_role": string }; Returns: Database["api"]['CompositeTypes']["invitation_row"]
                          SetofOptions: {
        from: "*"
        to: "invitation_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_location":
{ Args: { "p_name": string,"p_org_id": string,"p_slug"?: string,"p_tz": string }; Returns: Database["api"]['CompositeTypes']["created_location"]
                          SetofOptions: {
        from: "*"
        to: "created_location"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_organization":
{ Args: { "p_location_name": string,"p_name": string,"p_tz": string }; Returns: Database["api"]['CompositeTypes']["org_bootstrap"]
                          SetofOptions: {
        from: "*"
        to: "org_bootstrap"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_pairing_code":
{ Args: { "p_kind": Database["app"]['Enums']["device_kind"],"p_location_id": string,"p_name": string }; Returns: Database["api"]['CompositeTypes']["pairing_code"]
                          SetofOptions: {
        from: "*"
        to: "pairing_code"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_payment_hold":
{ Args: { "p_amount_minor": number,"p_appointment_id": string,"p_currency": string,"p_idempotency_key": string,"p_org_id": string,"p_provider": string,"p_provider_hold_id": string,"p_visit_id": string }; Returns: string
                           },
"create_webhook_endpoint":
{ Args: { "p_event_types": (string)[],"p_idempotency_key": string,"p_include_guest_name": boolean,"p_kind": string,"p_org_id": string,"p_url": string }; Returns: Database["api"]['CompositeTypes']["webhook_endpoint_created"]
                          SetofOptions: {
        from: "*"
        to: "webhook_endpoint_created"
        isOneToOne: true
        isSetofReturn: false
      } },
"delete_time_blocks":
{ Args: { "p_block_ids": (string)[],"p_idempotency_key": string }; Returns: number
                           },
"detach_form":
{ Args: { "p_channel"?: string,"p_form_id": string,"p_org_id": string,"p_target_ids": (string)[] }; Returns: number
                           },
"dev_record_inbound":
{ Args: { "p_actor": string,"p_body": string,"p_from_e164": string,"p_org_id": string }; Returns: string
                           },
"device_heartbeat":
{ Args: { "p_app_version": string,"p_disconnects"?: number }; Returns: undefined
                           },
"display_onsite_code":
{ Args: { "p_location_id": string }; Returns: Database["api"]['CompositeTypes']["onsite_code"]
                          SetofOptions: {
        from: "*"
        to: "onsite_code"
        isOneToOne: true
        isSetofReturn: false
      } },
"display_signage":
{ Args: { "p_location_id": string }; Returns: Database["api"]['CompositeTypes']["signage_slide"][]
                          SetofOptions: {
        from: "*"
        to: "signage_slide"
        isOneToOne: false
        isSetofReturn: true
      } },
"display_snapshot":
{ Args: { "p_location_id": string }; Returns: Database["api"]['CompositeTypes']["display_snapshot"]
                          SetofOptions: {
        from: "*"
        to: "display_snapshot"
        isOneToOne: true
        isSetofReturn: false
      } },
"duplicate_guest_candidates":
{ Args: { "p_limit"?: number,"p_org_id": string }; Returns: Database["api"]['CompositeTypes']["duplicate_pair"][]
                          SetofOptions: {
        from: "*"
        to: "duplicate_pair"
        isOneToOne: false
        isSetofReturn: true
      } },
"end_operator_session":
{ Args: { "p_operator_token": string }; Returns: undefined
                           },
"erase_guest":
{ Args: { "p_guest_id": string,"p_idempotency_key": string,"p_keep_suppression": boolean,"p_reason": string }; Returns: Database["api"]['CompositeTypes']["erasure_result"]
                          SetofOptions: {
        from: "*"
        to: "erasure_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"eta_accuracy":
{ Args: { "p_from_day": string,"p_group": string,"p_location_id": string,"p_to_day": string }; Returns: Database["api"]['CompositeTypes']["eta_accuracy_row"][]
                          SetofOptions: {
        from: "*"
        to: "eta_accuracy_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"export_guest_data":
{ Args: { "p_guest_id": string }; Returns: Database["api"]['CompositeTypes']["guest_export"]
                          SetofOptions: {
        from: "*"
        to: "guest_export"
        isOneToOne: true
        isSetofReturn: false
      } },
"export_guests":
{ Args: { "p_org_id": string }; Returns: Database["api"]['CompositeTypes']["guest_export_row"][]
                          SetofOptions: {
        from: "*"
        to: "guest_export_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"export_waiver_records":
{ Args: { "p_from": string,"p_location_id": string,"p_to": string }; Returns: Json
                           },
"feedback_comments":
{ Args: { "p_after": string,"p_from_day": string,"p_limit": number,"p_location_id": string,"p_to_day": string }; Returns: Database["api"]['CompositeTypes']["feedback_comment_row"][]
                          SetofOptions: {
        from: "*"
        to: "feedback_comment_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"feedback_summary":
{ Args: { "p_from_day": string,"p_group": string,"p_location_id": string,"p_to_day": string }; Returns: Database["api"]['CompositeTypes']["feedback_summary_row"][]
                          SetofOptions: {
        from: "*"
        to: "feedback_summary_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"find_guest_data":
{ Args: { "p_email": string,"p_phone_e164": string }; Returns: Database["api"]['CompositeTypes']["guest_match"][]
                          SetofOptions: {
        from: "*"
        to: "guest_match"
        isOneToOne: false
        isSetofReturn: true
      } },
"find_visit_by_scan_code":
{ Args: { "p_code": string,"p_location_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"get_appointment":
{ Args: { "p_token": string }; Returns: Database["app"]['Enums']["appointment_status"]
                          SetofOptions: {
        from: "*"
        to: "appointment_status"
        isOneToOne: true
        isSetofReturn: false
      } },
"get_available_slots":
{ Args: { "p_from": string,"p_location_slug": string,"p_service_id": string,"p_to": string }; Returns: Database["api"]['CompositeTypes']["available_slot"][]
                          SetofOptions: {
        from: "*"
        to: "available_slot"
        isOneToOne: false
        isSetofReturn: true
      } },
"get_channel_config":
{ Args: { "p_channel": string,"p_org_id": string }; Returns: Database["api"]['CompositeTypes']["channel_config"]
                          SetofOptions: {
        from: "*"
        to: "channel_config"
        isOneToOne: true
        isSetofReturn: false
      } },
"get_guest":
{ Args: { "p_guest_id": string }; Returns: Database["api"]['CompositeTypes']["guest_profile"]
                          SetofOptions: {
        from: "*"
        to: "guest_profile"
        isOneToOne: true
        isSetofReturn: false
      } },
"get_join_form":
{ Args: { "p_channel"?: string,"p_queue_id": string,"p_service_id"?: string }; Returns: Json
                           },
"get_location_branding":
{ Args: { "p_slug": string }; Returns: Database["api"]['CompositeTypes']["location_branding"]
                          SetofOptions: {
        from: "*"
        to: "location_branding"
        isOneToOne: true
        isSetofReturn: false
      } },
"get_location_events":
{ Args: { "p_location_slug": string }; Returns: Database["api"]['CompositeTypes']["event_row"][]
                          SetofOptions: {
        from: "*"
        to: "event_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"get_location_lines":
{ Args: { "p_for"?: string,"p_location_slug": string }; Returns: Database["api"]['CompositeTypes']["public_line"][]
                          SetofOptions: {
        from: "*"
        to: "public_line"
        isOneToOne: false
        isSetofReturn: true
      } },
"get_location_public":
{ Args: { "p_location_slug": string }; Returns: Database["api"]['CompositeTypes']["location_public"]
                          SetofOptions: {
        from: "*"
        to: "location_public"
        isOneToOne: true
        isSetofReturn: false
      } },
"get_location_wait":
{ Args: { "p_location_slug": string }; Returns: Database["api"]['CompositeTypes']["public_wait"][]
                          SetofOptions: {
        from: "*"
        to: "public_wait"
        isOneToOne: false
        isSetofReturn: true
      } },
"get_org_deletion":
{ Args: { "p_org_id": string }; Returns: string
                           },
"get_telegram_bot":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"get_visit_info":
{ Args: { "p_token": string }; Returns: Database["api"]['CompositeTypes']["visit_info"]
                          SetofOptions: {
        from: "*"
        to: "visit_info"
        isOneToOne: true
        isSetofReturn: false
      } },
"get_visit_status":
{ Args: { "p_token": string }; Returns: Database["api"]['CompositeTypes']["visit_status"]
                          SetofOptions: {
        from: "*"
        to: "visit_status"
        isOneToOne: true
        isSetofReturn: false
      } },
"get_webhook_secret":
{ Args: { "p_endpoint_id": string,"p_provider": string }; Returns: Database["api"]['CompositeTypes']["webhook_secret"]
                          SetofOptions: {
        from: "*"
        to: "webhook_secret"
        isOneToOne: true
        isSetofReturn: false
      } },
"get_whatsapp_send":
{ Args: { "p_outbox_id": string }; Returns: {
              "mode": string,"wa_language": string,"wa_name": string,"window_open": boolean
            }[]
                           },
"grant_support_access":
{ Args: { "p_hours": number,"p_org_id": string,"p_reason": string,"p_scope": string }; Returns: Database["app"]['Tables']["support_grants"]['Row']
                          SetofOptions: {
        from: "*"
        to: "support_grants"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_act":
{ Args: { "p_action": Database["api"]['Enums']["guest_action"],"p_idempotency_key": string,"p_token": string }; Returns: Database["api"]['CompositeTypes']["visit_status"]
                          SetofOptions: {
        from: "*"
        to: "visit_status"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_add_companion":
{ Args: { "p_first_name": string,"p_idempotency_key": string,"p_token": string }; Returns: Database["api"]['CompositeTypes']["visit_status"]
                          SetofOptions: {
        from: "*"
        to: "visit_status"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_badges":
{ Args: { "p_visit_ids": (string)[] }; Returns: Database["api"]['CompositeTypes']["guest_badge"][]
                          SetofOptions: {
        from: "*"
        to: "guest_badge"
        isOneToOne: false
        isSetofReturn: true
      } },
"guest_cancel_appointment":
{ Args: { "p_idempotency_key": string,"p_token": string }; Returns: Database["app"]['Enums']["appointment_status"]
                          SetofOptions: {
        from: "*"
        to: "appointment_status"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_claim_offer":
{ Args: { "p_idempotency_key": string,"p_token": string }; Returns: Database["api"]['CompositeTypes']["booking_result"]
                          SetofOptions: {
        from: "*"
        to: "booking_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_create_link_code":
{ Args: { "p_channel": string,"p_token": string }; Returns: Database["api"]['CompositeTypes']["link_code"]
                          SetofOptions: {
        from: "*"
        to: "link_code"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_get_alert_prefs":
{ Args: { "p_token": string }; Returns: Database["api"]['CompositeTypes']["alert_prefs"]
                          SetofOptions: {
        from: "*"
        to: "alert_prefs"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_get_waitlist":
{ Args: { "p_token": string }; Returns: Database["app"]['Enums']["waitlist_status"]
                          SetofOptions: {
        from: "*"
        to: "waitlist_status"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_grant_consent":
{ Args: { "p_channel": string,"p_locale": string,"p_text_hash": string,"p_text_version": number,"p_token": string }; Returns: Database["api"]['CompositeTypes']["consent_row"]
                          SetofOptions: {
        from: "*"
        to: "consent_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_join_waitlist":
{ Args: { "p_email": string,"p_idempotency_key": string,"p_join_pass"?: string,"p_location_slug": string,"p_name": string,"p_phone_e164": string,"p_service_id": string,"p_wanted_day": string,"p_window_end": string,"p_window_start": string }; Returns: string
                           },
"guest_leave_waitlist":
{ Args: { "p_token": string }; Returns: undefined
                           },
"guest_list_messages":
{ Args: { "p_after_id"?: number,"p_token": string }; Returns: Database["api"]['CompositeTypes']["chat_message"][]
                          SetofOptions: {
        from: "*"
        to: "chat_message"
        isOneToOne: false
        isSetofReturn: true
      } },
"guest_register_appointment_push":
{ Args: { "p_auth": string,"p_endpoint": string,"p_p256dh": string,"p_token": string }; Returns: undefined
                           },
"guest_register_push":
{ Args: { "p_auth": string,"p_endpoint": string,"p_p256dh": string,"p_token": string }; Returns: undefined
                           },
"guest_remove_companion":
{ Args: { "p_companion_id": string,"p_token": string }; Returns: Database["api"]['CompositeTypes']["visit_status"]
                          SetofOptions: {
        from: "*"
        to: "visit_status"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_request_phone_code":
{ Args: { "p_token": string }; Returns: Database["api"]['CompositeTypes']["phone_verification"]
                          SetofOptions: {
        from: "*"
        to: "phone_verification"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_reschedule_appointment":
{ Args: { "p_idempotency_key": string,"p_new_slot_start": string,"p_token": string }; Returns: Database["app"]['Enums']["appointment_status"]
                          SetofOptions: {
        from: "*"
        to: "appointment_status"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_send_message":
{ Args: { "p_body": string,"p_idempotency_key": string,"p_token": string }; Returns: Database["api"]['CompositeTypes']["chat_message"]
                          SetofOptions: {
        from: "*"
        to: "chat_message"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_set_alert_prefs":
{ Args: { "p_idempotency_key": string,"p_token": string,"p_triggers": (string)[] }; Returns: Database["api"]['CompositeTypes']["alert_prefs"]
                          SetofOptions: {
        from: "*"
        to: "alert_prefs"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_submit_feedback":
{ Args: { "p_comment": string,"p_idempotency_key": string,"p_nps": number,"p_rating": number,"p_token": string }; Returns: Database["api"]['CompositeTypes']["feedback_result"]
                          SetofOptions: {
        from: "*"
        to: "feedback_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"guest_verify_phone_code":
{ Args: { "p_code": string,"p_token": string }; Returns: Database["api"]['CompositeTypes']["phone_verification"]
                          SetofOptions: {
        from: "*"
        to: "phone_verification"
        isOneToOne: true
        isSetofReturn: false
      } },
"health_report":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"history_stats":
{ Args: { "p_bucket": string,"p_from": string,"p_location_id": string,"p_queue_id"?: string,"p_service_id"?: string,"p_to": string }; Returns: Database["api"]['CompositeTypes']["history_bucket"][]
                          SetofOptions: {
        from: "*"
        to: "history_bucket"
        isOneToOne: false
        isSetofReturn: true
      } },
"hit_rate_limit":
{ Args: { "p_count"?: boolean,"p_key": string,"p_limit": number,"p_window_seconds": number }; Returns: boolean
                           },
"import_guests":
{ Args: { "p_idempotency_key": string,"p_org_id": string,"p_rows": Json }; Returns: Database["api"]['CompositeTypes']["import_row_result"][]
                          SetofOptions: {
        from: "*"
        to: "import_row_result"
        isOneToOne: false
        isSetofReturn: true
      } },
"issue_join_pass":
{ Args: { "p_hostname": string }; Returns: string
                           },
"join_queue":
{ Args: { "p_answers"?: Json,"p_arrive_after"?: string,"p_device_key"?: string,"p_email": string,"p_group_key"?: string,"p_idempotency_key": string,"p_join_pass"?: string,"p_locale": string,"p_location_id"?: string,"p_name": string,"p_onsite_code"?: string,"p_party_size": number,"p_phone_e164": string,"p_queue_id": string,"p_service_id": string }; Returns: Database["api"]['CompositeTypes']["join_result"]
                          SetofOptions: {
        from: "*"
        to: "join_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"list_appointments":
{ Args: { "p_from": string,"p_location_id": string,"p_to": string }; Returns: Database["api"]['CompositeTypes']["appointment_row"][]
                          SetofOptions: {
        from: "*"
        to: "appointment_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_failed_notifications":
{ Args: { "p_location_id": string,"p_since": string }; Returns: Database["app"]['Enums']["notification_status"][]
                          SetofOptions: {
        from: "*"
        to: "notification_status"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_guest_notices":
{ Args: { "p_log_id": string }; Returns: Database["api"]['CompositeTypes']["guest_notice"][]
                          SetofOptions: {
        from: "*"
        to: "guest_notice"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_industry_templates":
{ Args: Record<PropertyKey, never>; Returns: Database["api"]['CompositeTypes']["industry_template"][]
                          SetofOptions: {
        from: "*"
        to: "industry_template"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_members":
{ Args: { "p_org_id": string }; Returns: Database["api"]['CompositeTypes']["membership_row"][]
                          SetofOptions: {
        from: "*"
        to: "membership_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_report_schedules":
{ Args: { "p_org_id": string }; Returns: Database["api"]['CompositeTypes']["report_schedule_row"][]
                          SetofOptions: {
        from: "*"
        to: "report_schedule_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_shifts":
{ Args: { "p_from_day": string,"p_location_id": string,"p_to_day": string }; Returns: Database["api"]['CompositeTypes']["shift_row"][]
                          SetofOptions: {
        from: "*"
        to: "shift_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_template_catalog":
{ Args: Record<PropertyKey, never>; Returns: Database["api"]['CompositeTypes']["template_catalog_entry"][]
                          SetofOptions: {
        from: "*"
        to: "template_catalog_entry"
        isOneToOne: false
        isSetofReturn: true
      } },
"list_visit_notifications":
{ Args: { "p_visit_id": string }; Returns: Database["app"]['Enums']["notification_status"][]
                          SetofOptions: {
        from: "*"
        to: "notification_status"
        isOneToOne: false
        isSetofReturn: true
      } },
"location_channels":
{ Args: { "p_location_id": string }; Returns: (string)[]
                           },
"location_comparison":
{ Args: { "p_from_day": string,"p_org_id": string,"p_to_day": string }; Returns: Database["api"]['CompositeTypes']["location_metrics"][]
                          SetofOptions: {
        from: "*"
        to: "location_metrics"
        isOneToOne: false
        isSetofReturn: true
      } },
"log_manual_contact":
{ Args: { "p_channel": string,"p_visit_id": string }; Returns: string
                           },
"mark_org_purged_externally":
{ Args: { "p_org_id": string }; Returns: undefined
                           },
"mark_webhook_processed":
{ Args: { "p_error"?: string,"p_event_id": number }; Returns: undefined
                           },
"merge_guests":
{ Args: { "p_idempotency_key": string,"p_keep_id": string,"p_merge_id": string }; Returns: Database["api"]['CompositeTypes']["guest_row"]
                          SetofOptions: {
        from: "*"
        to: "guest_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"move_visit":
{ Args: { "p_after_visit_id": string,"p_expected_version": number,"p_idempotency_key": string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"my_permissions":
{ Args: { "p_location_id"?: string,"p_org_id": string }; Returns: (string)[]
                           },
"org_billing":
{ Args: { "p_org_id": string }; Returns: {
              "billing_interval": string,"currency": string,"current_period_end": string,"enabled": boolean,"grace_ends_at": string,"locations": number,"paid_channels": boolean,"plan_id": string,"plan_name": string,"plans": Json,"quantity": number,"status": string,"subscribed": boolean,"unit_price_minor": number
            }[]
                           },
"org_entitlements":
{ Args: Record<PropertyKey, never>; Returns: Json
                           },
"org_overview":
{ Args: { "p_org_id": string }; Returns: Database["api"]['CompositeTypes']["location_overview"][]
                          SetofOptions: {
        from: "*"
        to: "location_overview"
        isOneToOne: false
        isSetofReturn: true
      } },
"org_purge_targets":
{ Args: { "p_org_id": string }; Returns: (string)[]
                           },
"org_setup_state":
{ Args: { "p_location_id": string,"p_org_id": string }; Returns: Database["api"]['CompositeTypes']["org_setup_state"]
                          SetofOptions: {
        from: "*"
        to: "org_setup_state"
        isOneToOne: true
        isSetofReturn: false
      } },
"outbox_still_relevant":
{ Args: { "p_outbox_id": string }; Returns: boolean
                           },
"outcome_rates":
{ Args: { "p_bucket": string,"p_from": string,"p_location_id": string,"p_to": string }; Returns: Database["api"]['CompositeTypes']["outcome_bucket"][]
                          SetofOptions: {
        from: "*"
        to: "outcome_bucket"
        isOneToOne: false
        isSetofReturn: true
      } },
"peak_heatmap":
{ Args: { "p_location_id": string,"p_target_util"?: number,"p_weeks"?: number }; Returns: Database["api"]['CompositeTypes']["heatmap_cell"][]
                          SetofOptions: {
        from: "*"
        to: "heatmap_cell"
        isOneToOne: false
        isSetofReturn: true
      } },
"pending_price_reconciliation":
{ Args: { "p_limit"?: number }; Returns: {
              "id": string,"org_id": string,"provider": string,"provider_message_id": string
            }[]
                           },
"platform_ack_attention":
{ Args: { "p_hours": number,"p_org_id": string,"p_reason": string }; Returns: undefined
                           },
"platform_add_incident_note":
{ Args: { "p_body": string,"p_id": string }; Returns: undefined
                           },
"platform_add_note":
{ Args: { "p_body": string,"p_idempotency_key"?: string,"p_note_id"?: string,"p_org_id": string,"p_tags"?: (string)[] }; Returns: Database["api"]['CompositeTypes']["platform_org_note"]
                          SetofOptions: {
        from: "*"
        to: "platform_org_note"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_approve_notice":
{ Args: { "p_id": string }; Returns: Database["api"]['CompositeTypes']["incident_notice"]
                          SetofOptions: {
        from: "*"
        to: "incident_notice"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_attention":
{ Args: { "p_limit"?: number }; Returns: Database["api"]['CompositeTypes']["platform_attention_row"][]
                          SetofOptions: {
        from: "*"
        to: "platform_attention_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_audit_export":
{ Args: { "p_action"?: string,"p_actor"?: string,"p_after"?: number,"p_from"?: string,"p_org_id"?: string,"p_to"?: string }; Returns: Database["api"]['CompositeTypes']["platform_audit_export"]
                          SetofOptions: {
        from: "*"
        to: "platform_audit_export"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_audit_search":
{ Args: { "p_action"?: string,"p_actor"?: string,"p_after"?: number,"p_from"?: string,"p_limit"?: number,"p_org_id"?: string,"p_to"?: string }; Returns: Database["api"]['CompositeTypes']["platform_audit_row"][]
                          SetofOptions: {
        from: "*"
        to: "platform_audit_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_billing_overview":
{ Args: Record<PropertyKey, never>; Returns: Database["api"]['CompositeTypes']["platform_billing_overview"]
                          SetofOptions: {
        from: "*"
        to: "platform_billing_overview"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_block_contact":
{ Args: { "p_expires_at": string,"p_kind": string,"p_reason": string,"p_value": string }; Returns: undefined
                           },
"platform_break_glass":
{ Args: { "p_org_id": string,"p_reason": string }; Returns: Database["app"]['Tables']["support_grants"]['Row']
                          SetofOptions: {
        from: "*"
        to: "support_grants"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_create_incident":
{ Args: { "p_data_categories"?: (string)[],"p_description"?: string,"p_detected_at"?: string,"p_idempotency_key"?: string,"p_kind": string,"p_org_ids"?: (string)[],"p_record_count"?: number,"p_title": string }; Returns: Database["api"]['CompositeTypes']["platform_incident"]
                          SetofOptions: {
        from: "*"
        to: "platform_incident"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_delivery_summary":
{ Args: { "p_from": string,"p_to": string }; Returns: Database["api"]['CompositeTypes']["platform_delivery_summary_row"][]
                          SetofOptions: {
        from: "*"
        to: "platform_delivery_summary_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_funnel":
{ Args: { "p_from"?: string,"p_limit"?: number,"p_offset"?: number,"p_stage"?: string,"p_to"?: string }; Returns: Database["api"]['CompositeTypes']["platform_funnel_result"]
                          SetofOptions: {
        from: "*"
        to: "platform_funnel_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_get_org":
{ Args: { "p_org_id": string }; Returns: Database["api"]['CompositeTypes']["platform_org_detail"]
                          SetofOptions: {
        from: "*"
        to: "platform_org_detail"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_health":
{ Args: Record<PropertyKey, never>; Returns: Database["api"]['CompositeTypes']["platform_health"]
                          SetofOptions: {
        from: "*"
        to: "platform_health"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_incident_break_glass":
{ Args: { "p_id": string }; Returns: Database["api"]['CompositeTypes']["platform_incident_break_glass"][]
                          SetofOptions: {
        from: "*"
        to: "platform_incident_break_glass"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_incident_tenants":
{ Args: { "p_id": string }; Returns: Database["api"]['CompositeTypes']["platform_incident_tenant"][]
                          SetofOptions: {
        from: "*"
        to: "platform_incident_tenant"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_list_announcements":
{ Args: Record<PropertyKey, never>; Returns: {
              "ends_at": string,"id": string,"message": string,"severity": Database["app"]['Enums']["announcement_severity"],"starts_at": string
            }[]
                           },
"platform_list_incidents":
{ Args: { "p_id"?: string,"p_status"?: Database["app"]['Enums']["incident_status"] }; Returns: Database["api"]['CompositeTypes']["platform_incident"][]
                          SetofOptions: {
        from: "*"
        to: "platform_incident"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_list_notes":
{ Args: { "p_include_history"?: boolean,"p_org_id": string }; Returns: Database["api"]['CompositeTypes']["platform_org_note"][]
                          SetofOptions: {
        from: "*"
        to: "platform_org_note"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_list_notices":
{ Args: { "p_incident_id": string }; Returns: Database["api"]['CompositeTypes']["incident_notice"][]
                          SetofOptions: {
        from: "*"
        to: "incident_notice"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_list_orgs":
{ Args: { "p_after"?: string,"p_limit"?: number,"p_search": string,"p_status"?: Database["app"]['Enums']["org_status"] }; Returns: Database["api"]['CompositeTypes']["platform_org_row"][]
                          SetofOptions: {
        from: "*"
        to: "platform_org_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_list_support_requests":
{ Args: { "p_org_id": string,"p_status"?: string }; Returns: Database["api"]['CompositeTypes']["platform_support_request"][]
                          SetofOptions: {
        from: "*"
        to: "platform_support_request"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_org_activation":
{ Args: { "p_org_ids": (string)[] }; Returns: Database["api"]['CompositeTypes']["platform_activation"][]
                          SetofOptions: {
        from: "*"
        to: "platform_activation"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_org_billing":
{ Args: { "p_org_id": string }; Returns: Database["api"]['CompositeTypes']["platform_org_billing"]
                          SetofOptions: {
        from: "*"
        to: "platform_org_billing"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_org_deliveries":
{ Args: { "p_after_at"?: string,"p_after_id"?: string,"p_channel"?: string,"p_from"?: string,"p_limit"?: number,"p_org_id": string,"p_status"?: string,"p_to"?: string }; Returns: Database["api"]['CompositeTypes']["platform_delivery_row"][]
                          SetofOptions: {
        from: "*"
        to: "platform_delivery_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_revoke_devices":
{ Args: { "p_org_id": string,"p_reason": string }; Returns: Json
                           },
"platform_revoke_role":
{ Args: { "p_allow_last_operator"?: boolean,"p_user_id": string }; Returns: Json
                           },
"platform_save_notice":
{ Args: { "p_body"?: string,"p_incident_id": string,"p_subject"?: string }; Returns: Database["api"]['CompositeTypes']["incident_notice"]
                          SetofOptions: {
        from: "*"
        to: "incident_notice"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_search_visits":
{ Args: { "p_limit"?: number,"p_org_id": string,"p_queue_id"?: string,"p_service_day"?: string,"p_status"?: Database["api"]['Enums']["visit_state"],"p_ticket"?: string }; Returns: Database["api"]['CompositeTypes']["platform_visit_hit"][]
                          SetofOptions: {
        from: "*"
        to: "platform_visit_hit"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_send_notice":
{ Args: { "p_id": string }; Returns: Database["api"]['CompositeTypes']["incident_notice"]
                          SetofOptions: {
        from: "*"
        to: "incident_notice"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_set_entitlement":
{ Args: { "p_key": string,"p_org_id": string,"p_reason": string,"p_value": Json }; Returns: undefined
                           },
"platform_set_org_status":
{ Args: { "p_org_id": string,"p_reason": string,"p_status": Database["app"]['Enums']["org_status"] }; Returns: Database["api"]['CompositeTypes']["platform_org_row"]
                          SetofOptions: {
        from: "*"
        to: "platform_org_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_set_sms_pause":
{ Args: { "p_org_id": string,"p_pause": boolean,"p_reason": string }; Returns: Json
                           },
"platform_set_support_request_status":
{ Args: { "p_request_id": string,"p_status": string }; Returns: undefined
                           },
"platform_sign_out_members":
{ Args: { "p_org_id": string,"p_reason": string }; Returns: Json
                           },
"platform_sms_analytics":
{ Args: { "p_from": string,"p_org_id"?: string,"p_to": string }; Returns: Database["app"]['Tables']["platform_sms_daily"]['Row'][]
                          SetofOptions: {
        from: "*"
        to: "platform_sms_daily"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_sms_health":
{ Args: { "p_org_id": string }; Returns: Json
                           },
"platform_stats":
{ Args: { "p_from": string,"p_to": string }; Returns: Database["app"]['Tables']["platform_daily_stats"]['Row'][]
                          SetofOptions: {
        from: "*"
        to: "platform_daily_stats"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_tagged_orgs":
{ Args: { "p_tags"?: (string)[] }; Returns: Database["api"]['CompositeTypes']["platform_tagged_org"][]
                          SetofOptions: {
        from: "*"
        to: "platform_tagged_org"
        isOneToOne: false
        isSetofReturn: true
      } },
"platform_team":
{ Args: Record<PropertyKey, never>; Returns: {
              "email": string,"granted_at": string,"granted_by": string,"granted_by_email": string,"is_you": boolean,"last_sign_in_at": string,"mfa_enrolled": boolean,"role": Database["app"]['Enums']["platform_role"],"user_id": string
            }[]
                           },
"platform_transfer_ownership":
{ Args: { "p_new_owner_email": string,"p_org_id": string,"p_reason": string }; Returns: Database["api"]['CompositeTypes']["platform_org_row"]
                          SetofOptions: {
        from: "*"
        to: "platform_org_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_unblock_contact":
{ Args: { "p_kind": string,"p_value": string }; Returns: undefined
                           },
"platform_update_incident":
{ Args: { "p_containment"?: string,"p_data_categories"?: (string)[],"p_id": string,"p_lessons"?: string,"p_mark_notified"?: boolean,"p_org_ids"?: (string)[],"p_record_count"?: number,"p_root_cause"?: string,"p_status"?: Database["app"]['Enums']["incident_status"],"p_waive_reason"?: string }; Returns: Database["api"]['CompositeTypes']["platform_incident"]
                          SetofOptions: {
        from: "*"
        to: "platform_incident"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_upsert_announcement":
{ Args: { "p_ends_at": string,"p_id"?: string,"p_message": string,"p_severity": Database["app"]['Enums']["announcement_severity"],"p_starts_at"?: string }; Returns: string
                           },
"platform_visit_timeline":
{ Args: { "p_org_id": string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["platform_visit_timeline"]
                          SetofOptions: {
        from: "*"
        to: "platform_visit_timeline"
        isOneToOne: true
        isSetofReturn: false
      } },
"platform_whoami":
{ Args: Record<PropertyKey, never>; Returns: Database["app"]['Enums']["platform_role"]
                           },
"process_inbound_message":
{ Args: { "p_body": string,"p_channel": string,"p_from": string,"p_org_id": string,"p_provider": string,"p_provider_message_id": string,"p_to": string }; Returns: Database["api"]['CompositeTypes']["inbound_result"]
                          SetofOptions: {
        from: "*"
        to: "inbound_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"process_telegram_message":
{ Args: { "p_chat_id": string,"p_text": string,"p_update_id": string }; Returns: Json
                           },
"process_voice_call":
{ Args: { "p_call_sid": string,"p_digits": string,"p_from": string,"p_org_id": string,"p_step": string,"p_verified": boolean,"p_visit_id": string }; Returns: Json
                           },
"publish_form_version":
{ Args: { "p_form_id": string,"p_org_id": string }; Returns: number
                           },
"record_domain_check":
{ Args: { "p_domain_id": string,"p_ok": boolean }; Returns: Database["api"]['CompositeTypes']["custom_domain_row"]
                          SetofOptions: {
        from: "*"
        to: "custom_domain_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"record_payment_event":
{ Args: { "p_amount_minor": number,"p_at": string,"p_event_id": string,"p_provider": string,"p_provider_hold_id": string,"p_type": string }; Returns: string
                           },
"record_webhook_event":
{ Args: { "p_event_key": string,"p_org_id": string,"p_payload": Json,"p_provider": string }; Returns: Database["api"]['CompositeTypes']["webhook_record"]
                          SetofOptions: {
        from: "*"
        to: "webhook_record"
        isOneToOne: true
        isSetofReturn: false
      } },
"redeem_link_code":
{ Args: { "p_chat_id": string,"p_code": string }; Returns: Database["api"]['CompositeTypes']["link_result"]
                          SetofOptions: {
        from: "*"
        to: "link_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"redeem_pairing_code":
{ Args: { "p_client_key": string,"p_code": string }; Returns: Database["api"]['CompositeTypes']["device_claim"]
                          SetofOptions: {
        from: "*"
        to: "device_claim"
        isOneToOne: true
        isSetofReturn: false
      } },
"redeliver_webhook":
{ Args: { "p_delivery_id": string }; Returns: undefined
                           },
"register_device":
{ Args: { "p_auth_user_id": string,"p_device_id": string }; Returns: undefined
                           },
"remove_custom_domain":
{ Args: { "p_domain_id": string,"p_idempotency_key": string }; Returns: undefined
                           },
"remove_guest_contact":
{ Args: { "p_contact_id": string }; Returns: undefined
                           },
"remove_member":
{ Args: { "p_idempotency_key": string,"p_membership_id": string,"p_reason": string }; Returns: Database["api"]['CompositeTypes']["membership_row"]
                          SetofOptions: {
        from: "*"
        to: "membership_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"report_billing_result":
{ Args: { "p_job_id": string,"p_result": Json }; Returns: undefined
                           },
"report_incident":
{ Args: { "p_data_categories"?: (string)[],"p_description"?: string,"p_detected_at"?: string,"p_idempotency_key"?: string,"p_kind": string,"p_notify_platform"?: boolean,"p_org_id": string,"p_title": string }; Returns: string
                           },
"report_integration_result":
{ Args: { "p_job_id": string,"p_result": Json }; Returns: undefined
                           },
"report_outbox_result":
{ Args: { "p_outbox_id": string,"p_result": Json }; Returns: undefined
                           },
"report_payment_result":
{ Args: { "p_job_id": string,"p_result": Json }; Returns: undefined
                           },
"report_webhook_result":
{ Args: { "p_delivery_id": string,"p_result": Json }; Returns: undefined
                           },
"request_org_deletion":
{ Args: { "p_confirm_slug": string,"p_org_id": string }; Returns: string
                           },
"reserve_send":
{ Args: { "p_outbox_id": string }; Returns: Database["api"]['CompositeTypes']["send_reservation"]
                          SetofOptions: {
        from: "*"
        to: "send_reservation"
        isOneToOne: true
        isSetofReturn: false
      } },
"resolve_custom_domain":
{ Args: { "p_host": string }; Returns: string
                           },
"retry_notification":
{ Args: { "p_idempotency_key": string,"p_notification_id": string }; Returns: Database["app"]['Enums']["notification_status"]
                          SetofOptions: {
        from: "*"
        to: "notification_status"
        isOneToOne: true
        isSetofReturn: false
      } },
"revoke_api_key":
{ Args: { "p_key_id": string }; Returns: Database["api"]['CompositeTypes']["api_key_row"]
                          SetofOptions: {
        from: "*"
        to: "api_key_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"revoke_calendar_feed":
{ Args: { "p_feed_id": string }; Returns: undefined
                           },
"revoke_device":
{ Args: { "p_device_id": string }; Returns: undefined
                           },
"revoke_integration":
{ Args: { "p_channel": string,"p_merchant_id"?: string,"p_org_id": string }; Returns: undefined
                           },
"revoke_invitation":
{ Args: { "p_idempotency_key": string,"p_invitation_id": string }; Returns: Database["api"]['CompositeTypes']["invitation_row"]
                          SetofOptions: {
        from: "*"
        to: "invitation_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"revoke_support_access":
{ Args: { "p_org_id": string }; Returns: undefined
                           },
"rotate_webhook_secret":
{ Args: { "p_endpoint_id": string }; Returns: Database["api"]['CompositeTypes']["webhook_endpoint_created"]
                          SetofOptions: {
        from: "*"
        to: "webhook_endpoint_created"
        isOneToOne: true
        isSetofReturn: false
      } },
"run_report":
{ Args: { "p_definition": Json,"p_from": string,"p_to": string }; Returns: Database["api"]['CompositeTypes']["report_cell"][]
                          SetofOptions: {
        from: "*"
        to: "report_cell"
        isOneToOne: false
        isSetofReturn: true
      } },
"save_form_draft":
{ Args: { "p_fields": Json,"p_form_id": string,"p_location_id": string,"p_name": string,"p_org_id": string,"p_purpose_text": string,"p_retention_days": number }; Returns: string
                           },
"save_guest_notice":
{ Args: { "p_body": string,"p_location_id"?: string,"p_log_id": string,"p_subject": string,"p_window_from": string,"p_window_to": string }; Returns: Database["api"]['CompositeTypes']["guest_notice"]
                          SetofOptions: {
        from: "*"
        to: "guest_notice"
        isOneToOne: true
        isSetofReturn: false
      } },
"save_integration_tokens":
{ Args: { "p_channel": string,"p_config": Json,"p_org_id": string,"p_secrets": Json,"p_verified": boolean }; Returns: undefined
                           },
"search_appointments":
{ Args: { "p_after"?: string,"p_from": string,"p_limit"?: number,"p_location_id": string,"p_query": string,"p_statuses": (string)[],"p_to": string }; Returns: Database["api"]['CompositeTypes']["appointment_search_row"][]
                          SetofOptions: {
        from: "*"
        to: "appointment_search_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"search_guests":
{ Args: { "p_location_id": string,"p_query": string }; Returns: Database["api"]['CompositeTypes']["guest_summary"][]
                          SetofOptions: {
        from: "*"
        to: "guest_summary"
        isOneToOne: false
        isSetofReturn: true
      } },
"search_visits":
{ Args: { "p_days"?: number,"p_limit"?: number,"p_location_id": string,"p_query": string }; Returns: Database["api"]['CompositeTypes']["visit_row"][]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"send_guest_notice":
{ Args: { "p_id": string }; Returns: Database["api"]['CompositeTypes']["guest_notice"]
                          SetofOptions: {
        from: "*"
        to: "guest_notice"
        isOneToOne: true
        isSetofReturn: false
      } },
"send_queue_message":
{ Args: { "p_body": string,"p_idempotency_key": string,"p_queue_id": string }; Returns: Database["api"]['CompositeTypes']["broadcast_result"]
                          SetofOptions: {
        from: "*"
        to: "broadcast_result"
        isOneToOne: true
        isSetofReturn: false
      } },
"send_report_preview":
{ Args: { "p_schedule_id": string }; Returns: undefined
                           },
"send_webhook_test":
{ Args: { "p_endpoint_id": string }; Returns: undefined
                           },
"set_booking_answers":
{ Args: { "p_answers": Json,"p_token": string }; Returns: Json
                           },
"set_channel_enabled":
{ Args: { "p_channel": string,"p_enabled": boolean,"p_idempotency_key": string,"p_org_id": string }; Returns: Database["api"]['CompositeTypes']["channel_status"]
                          SetofOptions: {
        from: "*"
        to: "channel_status"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_device_counter":
{ Args: { "p_counter_id": string,"p_device_id": string }; Returns: undefined
                           },
"set_member_custom_role":
{ Args: { "p_custom_role_id": string,"p_idempotency_key": string,"p_membership_id": string }; Returns: Database["api"]['CompositeTypes']["membership_row"]
                          SetofOptions: {
        from: "*"
        to: "membership_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_member_locations":
{ Args: { "p_idempotency_key": string,"p_location_ids": (string)[],"p_membership_id": string }; Returns: Database["api"]['CompositeTypes']["membership_row"]
                          SetofOptions: {
        from: "*"
        to: "membership_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_member_role":
{ Args: { "p_idempotency_key": string,"p_location_ids": (string)[],"p_membership_id": string,"p_role": string }; Returns: Database["api"]['CompositeTypes']["membership_row"]
                          SetofOptions: {
        from: "*"
        to: "membership_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_my_pin":
{ Args: { "p_org_id": string,"p_pin": string }; Returns: undefined
                           },
"set_my_presence":
{ Args: { "p_counter_id": string,"p_idempotency_key": string,"p_location_id": string,"p_status": string }; Returns: Database["api"]['CompositeTypes']["presence_row"]
                          SetofOptions: {
        from: "*"
        to: "presence_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_provider_settings":
{ Args: { "p_channel": string,"p_config": Json,"p_idempotency_key": string,"p_mode": string,"p_org_id": string,"p_provider": string,"p_secrets": Json }; Returns: Database["api"]['CompositeTypes']["provider_settings_row"]
                          SetofOptions: {
        from: "*"
        to: "provider_settings_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_queue_state":
{ Args: { "p_queue_id": string,"p_state": Database["api"]['Enums']["queue_state"] }; Returns: Database["api"]['CompositeTypes']["queue_row"]
                          SetofOptions: {
        from: "*"
        to: "queue_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_require_mfa":
{ Args: { "p_org_id": string,"p_required": boolean }; Returns: undefined
                           },
"set_visit_answers":
{ Args: { "p_answers": Json,"p_expected_version": number,"p_idempotency_key": string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_visit_priority":
{ Args: { "p_expected_version": number,"p_idempotency_key": string,"p_priority_class_id": string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_wait_override":
{ Args: { "p_idempotency_key": string,"p_minutes": number,"p_queue_id": string,"p_until": string }; Returns: Database["api"]['CompositeTypes']["queue_row"]
                          SetofOptions: {
        from: "*"
        to: "queue_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_webhook_active":
{ Args: { "p_active": boolean,"p_endpoint_id": string }; Returns: undefined
                           },
"set_webhook_alert_thresholds":
{ Args: { "p_endpoint_id": string,"p_thresholds": Json }; Returns: undefined
                           },
"staff_add_visit":
{ Args: { "p_idempotency_key": string,"p_name": string,"p_party_size": number,"p_phone_e164": string,"p_queue_id": string,"p_service_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"staff_book_appointment":
{ Args: { "p_email": string,"p_idempotency_key": string,"p_location_id": string,"p_name": string,"p_override_capacity": boolean,"p_party_size": number,"p_phone_e164": string,"p_service_id": string,"p_slot_start": string,"p_staff_user_id": string }; Returns: Database["api"]['CompositeTypes']["appointment_row"]
                          SetofOptions: {
        from: "*"
        to: "appointment_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"staff_cancel_appointment":
{ Args: { "p_appointment_id": string,"p_expected_version": number,"p_idempotency_key": string,"p_reason": string }; Returns: Database["api"]['CompositeTypes']["appointment_row"]
                          SetofOptions: {
        from: "*"
        to: "appointment_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"staff_capture_consent":
{ Args: { "p_attested": boolean,"p_channel": string,"p_idempotency_key": string,"p_text_version": number,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["consent_row"]
                          SetofOptions: {
        from: "*"
        to: "consent_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"staff_charge_no_show":
{ Args: { "p_idempotency_key": string,"p_payment_id": string }; Returns: Database["api"]['CompositeTypes']["payment_row"]
                          SetofOptions: {
        from: "*"
        to: "payment_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"staff_create_pay_code":
{ Args: { "p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["pay_code"]
                          SetofOptions: {
        from: "*"
        to: "pay_code"
        isOneToOne: true
        isSetofReturn: false
      } },
"staff_mark_read":
{ Args: { "p_up_to_id": number,"p_visit_id": string }; Returns: undefined
                           },
"staff_performance":
{ Args: { "p_by": string,"p_from_day": string,"p_location_id": string,"p_to_day": string }; Returns: Database["api"]['CompositeTypes']["performance_row"][]
                          SetofOptions: {
        from: "*"
        to: "performance_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"staff_refund_payment":
{ Args: { "p_amount_minor": number,"p_idempotency_key": string,"p_payment_id": string,"p_reason": string }; Returns: Database["api"]['CompositeTypes']["payment_row"]
                          SetofOptions: {
        from: "*"
        to: "payment_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"staff_request_payment":
{ Args: { "p_amount_minor": number,"p_currency": string,"p_idempotency_key": string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["payment_row"]
                          SetofOptions: {
        from: "*"
        to: "payment_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"staff_send_message":
{ Args: { "p_body": string,"p_idempotency_key": string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["chat_message"]
                          SetofOptions: {
        from: "*"
        to: "chat_message"
        isOneToOne: true
        isSetofReturn: false
      } },
"staff_set_companions":
{ Args: { "p_expected_version": number,"p_idempotency_key": string,"p_names": (string)[],"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"suppress_by_message":
{ Args: { "p_org_id": string,"p_provider": string,"p_provider_message_id": string,"p_reason": string }; Returns: boolean
                           },
"switch_operator":
{ Args: { "p_location_id": string,"p_pin": string,"p_user_id": string }; Returns: Database["api"]['CompositeTypes']["operator_session"]
                          SetofOptions: {
        from: "*"
        to: "operator_session"
        isOneToOne: true
        isSetofReturn: false
      } },
"today_stats":
{ Args: { "p_location_id": string }; Returns: Database["api"]['CompositeTypes']["today_stats"]
                          SetofOptions: {
        from: "*"
        to: "today_stats"
        isOneToOne: true
        isSetofReturn: false
      } },
"touch_session":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"transfer_visit":
{ Args: { "p_expected_version": number,"p_idempotency_key": string,"p_to_queue_id": string,"p_to_service_id": string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"transition_visit":
{ Args: { "p_action": Database["api"]['Enums']["visit_action"],"p_counter_id"?: string,"p_expected_version": number,"p_idempotency_key": string,"p_reason"?: string,"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"unblock":
{ Args: { "p_block_id": string }; Returns: undefined
                           },
"undo_event":
{ Args: { "p_event_id": number,"p_idempotency_key": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"unlink_telegram_chat":
{ Args: { "p_chat_id": string }; Returns: number
                           },
"unsubscribe_outbox":
{ Args: { "p_outbox_id": string }; Returns: undefined
                           },
"update_incident_log_entry":
{ Args: { "p_actions_taken"?: string,"p_description"?: string,"p_id": string,"p_people_affected"?: number,"p_regulator_notified"?: string }; Returns: undefined
                           },
"update_visit_notes":
{ Args: { "p_expected_version": number,"p_idempotency_key": string,"p_notes": string,"p_tags": (string)[],"p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_row"]
                          SetofOptions: {
        from: "*"
        to: "visit_row"
        isOneToOne: true
        isSetofReturn: false
      } },
"usage_summary":
{ Args: { "p_from": string,"p_org_id": string,"p_to": string }; Returns: Database["api"]['CompositeTypes']["usage_row"][]
                          SetofOptions: {
        from: "*"
        to: "usage_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"visit_history":
{ Args: { "p_visit_id": string }; Returns: Database["api"]['CompositeTypes']["visit_history_row"][]
                          SetofOptions: {
        from: "*"
        to: "visit_history_row"
        isOneToOne: false
        isSetofReturn: true
      } },
"visit_text_states":
{ Args: { "p_location_id": string }; Returns: {
              "text_state": string,"visit_id": string
            }[]
                           }
          }
          Enums: {
            "eta_state": "hidden"|"paused"|"unstaffed"|"next"|"over_hour"|"ok"|"uncertain"|"override","guest_action": "leave"|"on_my_way"|"need_more_time"|"check_in"|"undo_leave","queue_state": "open"|"paused"|"closed","visit_action": "call"|"recall"|"start"|"requeue"|"complete"|"no_show"|"cancel"|"remove"|"reinstate"|"expire"|"check_in","visit_state": "expected"|"waiting"|"called"|"serving"|"served"|"no_show"|"cancelled"|"removed"|"expired"
          }
          CompositeTypes: {
            "alert_prefs": {
                        "triggers": (string)[] | null,"available": (string)[] | null
                      },"api_key_created": {
                        "key_id": string | null,"prefix": string | null,"plaintext_key": string | null
                      },"api_key_row": {
                        "id": string | null,"org_id": string | null,"name": string | null,"prefix": string | null,"scopes": (string)[] | null,"location_ids": (string)[] | null,"created_at": string | null,"last_used_at": string | null,"expires_at": string | null,"revoked_at": string | null
                      },"appointment_row": {
                        "id": string | null,"location_id": string | null,"service_id": string | null,"staff_user_id": string | null,"starts_at": string | null,"ends_at": string | null,"status": string | null,"guest_name": string | null,"visit_id": string | null,"version": number | null
                      },"appointment_search_row": {
                        "id": string | null,"starts_at": string | null,"ends_at": string | null,"status": string | null,"guest_name": string | null,"service_name": string | null,"staff_name": string | null
                      },"appointment_series_result": {
                        "series_id": string | null,"booked": (string)[] | null,"conflicts": Json | null
                      },"appointment_status": {
                        "starts_at": string | null,"ends_at": string | null,"status": string | null,"service_name": string | null,"location_name": string | null,"location_slug": string | null,"can_reschedule": boolean | null,"can_cancel": boolean | null,"as_of": string | null
                      },"available_slot": {
                        "slot_start": string | null,"slot_end": string | null,"remaining": number | null
                      },"booking_result": {
                        "token": string | null,"starts_at": string | null,"ends_at": string | null,"service_name": string | null,"location_name": string | null,"status": string | null
                      },"broadcast_result": {
                        "broadcast_id": string | null,"recipients": number | null,"suppressed": number | null
                      },"bulk_block_result": {
                        "block_ids": (string)[] | null,"conflicts": (string)[] | null
                      },"calendar_feed_created": {
                        "feed_id": string | null,"token": string | null
                      },"channel_config": {
                        "provider": string | null,"mode": string | null,"config": Json | null,"secrets": Json | null,"enabled": boolean | null
                      },"channel_status": {
                        "channel": string | null,"enabled": boolean | null,"missing": (string)[] | null
                      },"chat_message": {
                        "id": number | null,"visit_id": string | null,"sender": string | null,"body": string | null,"created_at": string | null,"read_at": string | null
                      },"consent_row": {
                        "consent_id": string | null,"contact_id": string | null,"channel": string | null,"purpose": string | null,"status": string | null,"captured_at": string | null
                      },"counter_snapshot": {
                        "counter_label": string | null,"ticket": string | null,"status": string | null,"guest_first_name": string | null,"as_of": string | null
                      },"created_location": {
                        "location_id": string | null,"slug": string | null
                      },"custom_domain_row": {
                        "id": string | null,"org_id": string | null,"hostname": string | null,"default_location_id": string | null,"verification_token": string | null,"status": string | null,"verified_at": string | null,"last_checked_at": string | null
                      },"device_claim": {
                        "device_id": string | null,"org_id": string | null,"location_id": string | null,"kind": Database["app"]['Enums']["device_kind"] | null,"name": string | null,"scopes": (string)[] | null
                      },"display_queue": {
                        "id": string | null,"name": string | null,"state": Database["api"]['Enums']["queue_state"] | null,"now_serving": (Database["api"]['CompositeTypes']["display_ticket"])[] | null,"next_up": (Database["api"]['CompositeTypes']["display_ticket"])[] | null
                      },"display_snapshot": {
                        "location_id": string | null,"location_name": string | null,"names_enabled": boolean | null,"queues": (Database["api"]['CompositeTypes']["display_queue"])[] | null,"as_of": string | null
                      },"display_ticket": {
                        "display_ticket": string | null,"counter_label": string | null,"first_name": string | null,"called_at": string | null
                      },"duplicate_pair": {
                        "keep_id": string | null,"merge_id": string | null,"reason": string | null,"score": number | null
                      },"erasure_result": {
                        "guest_id": string | null,"visits_anonymized": number | null,"contacts_deleted": number | null,"erased_at": string | null
                      },"eta_accuracy_row": {
                        "grp": string | null,"visits": number | null,"within_range_pct": number | null,"median_error_min": number | null,"bias_min": number | null,"pct_early": number | null,"pct_late": number | null,"avg_late_min": number | null,"p90_error_min": number | null,"excluded_no_quote": number | null
                      },"event_row": {
                        "id": string | null,"location_id": string | null,"title": string | null,"starts_at": string | null,"ends_at": string | null,"capacity": number | null,"seats_taken": number | null,"status": string | null
                      },"export_ticket": {
                        "export_id": string | null,"format": string | null,"remaining_today": number | null,"expires_at": string | null
                      },"feedback_comment_row": {
                        "id": string | null,"visit_id": string | null,"rating": number | null,"nps": number | null,"comment": string | null,"created_at": string | null,"guest_id": string | null,"ticket": string | null,"service": string | null
                      },"feedback_result": {
                        "submitted": boolean | null,"already_submitted": boolean | null
                      },"feedback_summary_row": {
                        "grp": string | null,"responses": number | null,"avg_rating": number | null,"nps": number | null,"promoters": number | null,"passives": number | null,"detractors": number | null,"served": number | null,"rating_1": number | null,"rating_2": number | null,"rating_3": number | null,"rating_4": number | null,"rating_5": number | null
                      },"guest_badge": {
                        "visit_id": string | null,"visit_count": number | null,"last_visit_at": string | null,"is_repeat": boolean | null
                      },"guest_export": {
                        "guest": Json | null,"contacts": Json | null,"visits": Json | null,"appointments": Json | null,"notifications": Json | null,"consents": Json | null,"generated_at": string | null
                      },"guest_export_row": {
                        "guest_id": string | null,"name": string | null,"phone_e164": string | null,"email": string | null,"tags": (string)[] | null,"notes": string | null,"visit_count": number | null,"last_visit_at": string | null,"consent": Json | null
                      },"guest_match": {
                        "guest_id": string | null,"name": string | null,"visit_count": number | null,"last_visit_at": string | null
                      },"guest_notice": {
                        "id": string | null,"log_id": string | null,"subject": string | null,"body": string | null,"window_from": string | null,"window_to": string | null,"location_id": string | null,"status": string | null,"approved_at": string | null,"sent_at": string | null,"recipient_count": number | null,"updated_at": string | null
                      },"guest_profile": {
                        "guest_id": string | null,"name": string | null,"contacts": Json | null,"visits": Json | null,"appointments": Json | null,"visit_count": number | null,"first_visit_at": string | null,"last_visit_at": string | null
                      },"guest_row": {
                        "id": string | null,"name": string | null,"contacts": Json | null,"tags": (string)[] | null,"visit_count": number | null,"last_visit_at": string | null
                      },"guest_summary": {
                        "guest_id": string | null,"name": string | null,"masked_contact": string | null,"visit_count": number | null,"last_visit_at": string | null
                      },"heatmap_cell": {
                        "dow": number | null,"hour": number | null,"avg_arrivals": number | null,"avg_wait_min": number | null,"suggested_staff": number | null,"scheduled_staff": number | null
                      },"history_bucket": {
                        "bucket_start": string | null,"bucket_label": string | null,"joined": number | null,"served": number | null,"no_show": number | null,"cancelled": number | null,"removed": number | null,"expired": number | null,"avg_wait_s": number | null,"p50_wait_s": number | null,"p90_wait_s": number | null,"avg_service_s": number | null
                      },"import_row_result": {
                        "row_no": number | null,"outcome": string | null,"guest_id": string | null,"error": string | null
                      },"inbound_result": {
                        "inbound_id": string | null,"handled_as": string | null,"contact_id": string | null,"visit_id": string | null
                      },"incident_notice": {
                        "id": string | null,"incident_id": string | null,"subject": string | null,"body": string | null,"status": string | null,"approved_at": string | null,"sent_at": string | null,"org_count": number | null,"acknowledged_count": number | null,"updated_at": string | null
                      },"industry_template": {
                        "key": string | null,"name": string | null,"description": string | null,"health_tagged": boolean | null
                      },"integration_credentials": {
                        "org_id": string | null,"channel": string | null,"provider": string | null,"config": Json | null,"secrets": Json | null
                      },"integration_job": {
                        "id": string | null,"org_id": string | null,"channel": string | null,"provider": string | null,"kind": string | null,"config": Json | null,"secrets": Json | null,"attempts": number | null,"visit": Json | null,"contact": Json | null
                      },"invitation_row": {
                        "id": string | null,"org_id": string | null,"email": string | null,"role": string | null,"location_ids": (string)[] | null,"display_name": string | null,"expires_at": string | null,"accepted_at": string | null,"revoked_at": string | null,"token": string | null
                      },"join_result": {
                        "token": string | null,"display_ticket": string | null,"status": Database["api"]['Enums']["visit_state"] | null
                      },"link_code": {
                        "deep_link": string | null,"expires_at": string | null
                      },"link_result": {
                        "linked": boolean | null,"visit_id": string | null
                      },"location_branding": {
                        "org_name": string | null,"logo_url": string | null,"cover_url": string | null,"brand_primary": string | null,"brand_accent": string | null,"welcome_text": string | null,"terms_url": string | null,"privacy_url": string | null,"hide_product_branding": boolean | null
                      },"location_metrics": {
                        "location_id": string | null,"location_name": string | null,"visits": number | null,"avg_wait_min": number | null,"avg_service_min": number | null,"no_show_pct": number | null,"within_eta_pct": number | null,"median_service_min": number | null,"abandonment_pct": number | null,"avg_rating": number | null
                      },"location_overview": {
                        "location_id": string | null,"location_name": string | null,"queues_open": number | null,"waiting_count": number | null,"longest_wait_min": number | null,"eta_low": number | null,"eta_high": number | null,"as_of": string | null
                      },"location_public": {
                        "id": string | null,"name": string | null,"slug": string | null,"tz": string | null,"address": string | null,"contact": string | null,"queues": (Database["api"]['CompositeTypes']["public_queue"])[] | null,"country_code": string | null,"captcha_site_key": string | null,"retention_days": number | null,"routing": boolean | null,"sms_enabled": boolean | null,"privacy_contact": Json | null
                      },"membership_row": {
                        "id": string | null,"org_id": string | null,"user_id": string | null,"email": string | null,"display_name": string | null,"role": string | null,"location_ids": (string)[] | null,"has_pin": boolean | null,"created_at": string | null,"removed_at": string | null
                      },"notification_status": {
                        "id": string | null,"visit_id": string | null,"channel": string | null,"template": string | null,"status": string | null,"attempts": number | null,"last_error": string | null,"created_at": string | null,"sent_at": string | null,"delivered_at": string | null
                      },"onsite_code": {
                        "required": boolean | null,"code": string | null,"valid_until": string | null
                      },"operator_session": {
                        "operator_token": string | null,"user_id": string | null,"display_name": string | null,"role": string | null,"expires_at": string | null
                      },"org_bootstrap": {
                        "org_id": string | null,"location_id": string | null
                      },"org_setup_state": {
                        "location_id": string | null,"has_hours": boolean | null,"has_queue": boolean | null,"has_visit": boolean | null,"members": number | null,"pending_invitations": number | null,"devices": number | null,"as_of": string | null
                      },"outbox_job": {
                        "id": string | null,"org_id": string | null,"visit_id": string | null,"channel": Database["app"]['Enums']["notification_channel"] | null,"category": Database["app"]['Enums']["message_category"] | null,"template_key": string | null,"template_version": number | null,"locale": string | null,"subject": string | null,"body": string | null,"vars": Json | null,"recipient": Json | null,"has_consent": boolean | null,"is_suppressed": boolean | null,"location_tz": string | null,"attempts": number | null,"status_url": string | null
                      },"outcome_bucket": {
                        "bucket_start": string | null,"left_waiting": number | null,"cancelled": number | null,"abandonment_rate": number | null,"called": number | null,"no_show": number | null,"no_show_rate": number | null,"abandon_lt10": number | null,"abandon_10_30": number | null,"abandon_gt30": number | null
                      },"pairing_code": {
                        "code": string | null,"expires_at": string | null
                      },"pay_code": {
                        "code": string | null,"expires_at": string | null
                      },"payment_job": {
                        "id": string | null,"org_id": string | null,"payment_id": string | null,"action": string | null,"amount_minor": number | null,"attempts": number | null
                      },"payment_row": {
                        "id": string | null,"visit_id": string | null,"appointment_id": string | null,"provider": string | null,"kind": string | null,"status": string | null,"amount_minor": number | null,"currency": string | null,"updated_at": string | null
                      },"performance_row": {
                        "grp_id": string | null,"label": string | null,"served": number | null,"avg_service_sec": number | null,"avg_wait_sec": number | null,"no_shows": number | null
                      },"phone_verification": {
                        "state": string | null,"resend_after": string | null
                      },"platform_activation": {
                        "org_id": string | null,"org_status": Database["app"]['Enums']["org_status"] | null,"stage": string | null,"next_stage": string | null,"reached_at": string | null,"stuck_days": number | null,"is_stuck": boolean | null,"stages": Json | null
                      },"platform_attention_row": {
                        "org_id": string | null,"name": string | null,"org_status": Database["app"]['Enums']["org_status"] | null,"reason": string | null,"priority": number | null,"since": string | null,"detail": Json | null,"total": number | null
                      },"platform_audit_export": {
                        "csv": string | null,"row_count": number | null,"truncated": boolean | null,"next_after": number | null
                      },"platform_audit_row": {
                        "id": number | null,"at": string | null,"actor_id": string | null,"actor_email": string | null,"action": string | null,"org_id": string | null,"org_name": string | null,"reason": string | null,"support_grant_id": string | null,"break_glass_reason": string | null,"target": Json | null
                      },"platform_billing_overview": {
                        "billing_enabled": boolean | null,"past_due": number | null,"canceled_30d": number | null,"trials_ending_7d": number | null,"attention": Json | null
                      },"platform_delivery_row": {
                        "kind": string | null,"id": string | null,"org_id": string | null,"org_name": string | null,"created_at": string | null,"updated_at": string | null,"medium": string | null,"template_key": string | null,"status": string | null,"delivery_status": string | null,"error_code": string | null,"attempts": number | null,"provider": string | null,"suppression_reason": string | null,"recipient_masked": string | null
                      },"platform_delivery_summary_row": {
                        "medium": string | null,"provider": string | null,"sent": number | null,"failed": number | null,"suppressed": number | null,"pending": number | null,"failure_rate": number | null
                      },"platform_funnel_result": {
                        "from_date": string | null,"to_date": string | null,"stages": Json | null,"signups_without_business": number | null,"stuck_total": number | null,"stuck": Json | null
                      },"platform_health": {
                        "notifications_queued": number | null,"notifications_dead": number | null,"oldest_queued_seconds": number | null,"cron_jobs": Json | null,"orgs_active_today": number | null,"as_of": string | null
                      },"platform_incident": {
                        "id": string | null,"kind": string | null,"title": string | null,"description": string | null,"status": Database["app"]['Enums']["incident_status"] | null,"detected_at": string | null,"org_ids": (string)[] | null,"data_categories": (string)[] | null,"record_count": number | null,"containment": string | null,"root_cause": string | null,"lessons": string | null,"notified_at": string | null,"notice_waived_reason": string | null,"notify_due_at": string | null,"notify_state": string | null,"escalated": boolean | null,"created_at": string | null,"updated_at": string | null,"retain_until": string | null
                      },"platform_incident_break_glass": {
                        "at": string | null,"org_id": string | null,"org_name": string | null,"operator_email": string | null,"reason": string | null,"support_grant_id": string | null
                      },"platform_incident_tenant": {
                        "org_id": string | null,"org_name": string | null,"owners": Json | null,"breach_contact": Json | null
                      },"platform_org_billing": {
                        "billing_enabled": boolean | null,"org_status": Database["app"]['Enums']["org_status"] | null,"has_subscription": boolean | null,"plan_id": string | null,"plan_name": string | null,"effective_plan": string | null,"billing_interval": string | null,"status": string | null,"standing": string | null,"current_period_end": string | null,"locations_billed": number | null,"locations_wanted": number | null,"locations_actual": number | null,"grace_ends_at": string | null,"last_payment_failed_at": string | null,"grace_reminder_at": string | null,"stripe_customer_id": string | null,"entitlements": Json | null,"overrides": Json | null,"pending_jobs": Json | null
                      },"platform_org_detail": {
                        "org": Database["api"]['CompositeTypes']["platform_org_row"] | null,"suspended_reason": string | null,"suspended_at": string | null,"members": Json | null,"locations": Json | null,"devices": Json | null,"recent_audit": Json | null,"support_grant": Json | null
                      },"platform_org_note": {
                        "id": string | null,"version_id": string | null,"org_id": string | null,"author_id": string | null,"author_email": string | null,"body": string | null,"tags": (string)[] | null,"version": number | null,"created_at": string | null,"first_created_at": string | null
                      },"platform_org_row": {
                        "id": string | null,"name": string | null,"slug": string | null,"status": Database["app"]['Enums']["org_status"] | null,"created_at": string | null,"owner_email": string | null,"last_activity_at": string | null,"visits_7d": number | null,"notifications_sent_7d": number | null,"notifications_failed_7d": number | null,"members": number | null,"locations": number | null
                      },"platform_support_request": {
                        "id": string | null,"reference": string | null,"user_id": string | null,"user_email": string | null,"subject": string | null,"message": string | null,"context": Json | null,"status": string | null,"created_at": string | null,"closed_at": string | null
                      },"platform_tagged_org": {
                        "org_id": string | null,"org_name": string | null,"status": Database["app"]['Enums']["org_status"] | null,"tags": (string)[] | null,"needs_attention": boolean | null,"notes": number | null,"last_note_at": string | null
                      },"platform_visit_hit": {
                        "visit_id": string | null,"display_ticket": string | null,"queue_id": string | null,"queue_name": string | null,"location_id": string | null,"location_name": string | null,"service_day": string | null,"status": Database["api"]['Enums']["visit_state"] | null,"joined_at": string | null,"finished_at": string | null
                      },"platform_visit_timeline": {
                        "visit_id": string | null,"display_ticket": string | null,"status": Database["api"]['Enums']["visit_state"] | null,"queue_name": string | null,"location_name": string | null,"tz": string | null,"service_day": string | null,"source": string | null,"party_size": number | null,"call_count": number | null,"joined_at": string | null,"finished_at": string | null,"support_grant": Json | null,"events": Json | null,"notifications": Json | null
                      },"presence_row": {
                        "user_id": string | null,"location_id": string | null,"status": string | null,"counter_id": string | null,"since": string | null
                      },"provider_settings_row": {
                        "org_id": string | null,"channel": string | null,"provider": string | null,"mode": string | null,"config": Json | null,"secret_hints": Json | null,"endpoint_id": string | null,"messaging_campaign_ref": string | null,"verified_at": string | null,"enabled": boolean | null,"version": number | null
                      },"public_line": {
                        "queue_id": string | null,"name": string | null,"kind": string | null,"accepting": boolean | null,"not_accepting_reason": string | null,"waiting_count": number | null,"eta_state": Database["api"]['Enums']["eta_state"] | null,"eta_low": number | null,"eta_high": number | null,"selected": boolean | null
                      },"public_queue": {
                        "id": string | null,"name": string | null,"state": Database["api"]['Enums']["queue_state"] | null,"accepting": boolean | null,"not_accepting_reason": string | null,"waiting_count": number | null,"eta_state": Database["api"]['Enums']["eta_state"] | null,"eta_low": number | null,"eta_high": number | null,"pulse_id": string | null,"services": (Database["api"]['CompositeTypes']["public_service"])[] | null
                      },"public_service": {
                        "id": string | null,"name": string | null,"description": string | null
                      },"public_wait": {
                        "queue_id": string | null,"queue_name": string | null,"accepting": boolean | null,"waiting_count": number | null,"eta_low": number | null,"eta_high": number | null,"eta_state": Database["api"]['Enums']["eta_state"] | null,"opens_next_at": string | null,"as_of": string | null,"party_size_min": number | null,"party_size_max": number | null,"intake_fields": Json | null,"join_later_max_hours": number | null
                      },"queue_row": {
                        "id": string | null,"location_id": string | null,"name": string | null,"ticket_prefix": string | null,"manual_state": Database["api"]['Enums']["queue_state"] | null,"accepting": boolean | null,"not_accepting_reason": string | null,"servers_on_duty": number | null,"capacity": number | null,"waiting_count": number | null,"version": number | null
                      },"report_cell": {
                        "dims": Json | null,"measures": Json | null
                      },"report_schedule_row": {
                        "id": string | null,"location_id": string | null,"location_name": string | null,"tz": string | null,"frequency": string | null,"weekday": number | null,"send_at_local": string | null,"recipients": (string)[] | null,"enabled": boolean | null,"next_send_at": string | null
                      },"send_reservation": {
                        "decision": string | null,"sent_today": number | null,"daily_cap": number | null
                      },"shift_row": {
                        "id": string | null,"location_id": string | null,"user_id": string | null,"counter_id": string | null,"service_day": string | null,"starts_at": string | null,"ends_at": string | null,"note": string | null
                      },"signage_slide": {
                        "kind": string | null,"image_url": string | null,"body": string | null,"duration_s": number | null
                      },"template_catalog_entry": {
                        "key": string | null,"version": number | null,"name": string | null,"description": string | null,"tier": number | null,"mode": string | null,"health_tagged": boolean | null,"payload": Json | null
                      },"template_result": {
                        "template_key": string | null,"queues_created": number | null,"services_created": number | null,"counters_created": number | null
                      },"today_stats": {
                        "location_id": string | null,"service_day": string | null,"waiting_now": number | null,"served": number | null,"no_shows": number | null,"cancelled": number | null,"avg_wait_minutes": number | null,"as_of": string | null,"joined": number | null,"longest_wait_minutes": number | null,"busiest_hour": string | null
                      },"usage_row": {
                        "day": string | null,"channel": string | null,"provider": string | null,"messages": number | null,"segments": number | null,"cost_micros": number | null,"currency": string | null
                      },"visit_history_row": {
                        "occurred_at": string | null,"type": string | null,"from_status": Database["api"]['Enums']["visit_state"] | null,"to_status": Database["api"]['Enums']["visit_state"] | null,"actor_kind": string | null,"actor_label": string | null,"reason": string | null,"summary": Json | null
                      },"visit_info": {
                        "location_name": string | null,"address": string | null,"phone": string | null,"directions_url": string | null,"hours_today": Json | null,"service_name": string | null,"scheduled_at": string | null,"scan_code": string | null,"group_key": string | null,"locale": string | null
                      },"visit_row": {
                        "id": string | null,"queue_id": string | null,"service_id": string | null,"service_name": string | null,"display_ticket": string | null,"status": Database["api"]['Enums']["visit_state"] | null,"sort_key": number | null,"position": number | null,"party_size": number | null,"guest_name": string | null,"source": string | null,"counter_id": string | null,"counter_label": string | null,"call_count": number | null,"joined_at": string | null,"called_at": string | null,"serving_at": string | null,"finished_at": string | null,"eta_quoted_low": number | null,"eta_quoted_high": number | null,"version": number | null,"allowed_actions": (Database["api"]['Enums']["visit_action"])[] | null,"last_event_id": number | null
                      },"visit_status": {
                        "display_ticket": string | null,"status": Database["api"]['Enums']["visit_state"] | null,"position": number | null,"people_ahead": number | null,"eta_state": Database["api"]['Enums']["eta_state"] | null,"eta_low": number | null,"eta_high": number | null,"counter_label": string | null,"call_count": number | null,"called_at": string | null,"queue_name": string | null,"location_name": string | null,"queue_pulse_id": string | null,"guest_actions": (Database["api"]['Enums']["guest_action"])[] | null,"version": number | null,"as_of": string | null,"grace_until": string | null,"warn_at": string | null,"snoozes_left": number | null,"on_the_way": boolean | null,"companions": Json | null,"chat_version": number | null,"unread_staff_messages": number | null,"arrive_after": string | null,"text_consent": string | null
                      },"waitlist_status": {
                        "status": string | null,"service_name": string | null,"location_name": string | null,"location_slug": string | null,"wanted_day": string | null,"slot_start": string | null,"slot_end": string | null,"offer_expires_at": string | null,"as_of": string | null
                      },"webhook_endpoint_created": {
                        "id": string | null,"secret": string | null
                      },"webhook_job": {
                        "delivery_id": string | null,"url": string | null,"kind": string | null,"event_type": string | null,"payload": Json | null,"secret": string | null,"attempt": number | null
                      },"webhook_record": {
                        "event_id": number | null,"is_duplicate": boolean | null
                      },"webhook_secret": {
                        "org_id": string | null,"channel": string | null,"secrets": Json | null
                      }
          }
        },"app": {
          Tables: {
            "alert_preferences": {
                  Row: {
                    "org_id": string,"triggers": (string)[],"updated_at": string,"visit_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "org_id": string,"triggers"?: (string)[],"updated_at"?: string,"visit_id": string
                  }
                  Update: {
                    "org_id"?: string,"triggers"?: (string)[],"updated_at"?: string,"visit_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "alert_preferences_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "alert_preferences_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"analytics_questions": {
                  Row: {
                    "asked_at": string,"id": string,"org_id": string,"question": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "asked_at"?: string,"id"?: string,"org_id": string,"question": string,"user_id"?: string | null
                  }
                  Update: {
                    "asked_at"?: string,"id"?: string,"org_id"?: string,"question"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "analytics_questions_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"api_keys": {
                  Row: {
                    "created_at": string,"created_by": string | null,"expires_at": string | null,"id": string,"last_used_at": string | null,"location_ids": (string)[] | null,"name": string,"org_id": string,"prefix": string,"revoked_at": string | null,"scopes": (string)[],"secret_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"expires_at"?: string | null,"id"?: string,"last_used_at"?: string | null,"location_ids"?: (string)[] | null,"name": string,"org_id": string,"prefix": string,"revoked_at"?: string | null,"scopes": (string)[],"secret_hash": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"expires_at"?: string | null,"id"?: string,"last_used_at"?: string | null,"location_ids"?: (string)[] | null,"name"?: string,"org_id"?: string,"prefix"?: string,"revoked_at"?: string | null,"scopes"?: (string)[],"secret_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "api_keys_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"appointment_day_counts": {
                  Row: {
                    "count": number,"local_date": string,"org_id": string,"service_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "count"?: number,"local_date": string,"org_id": string,"service_id": string
                  }
                  Update: {
                    "count"?: number,"local_date"?: string,"org_id"?: string,"service_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointment_day_counts_org_id_service_id_fkey"
      columns: ["org_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"appointment_events": {
                  Row: {
                    "actor_id": string | null,"actor_kind": Database["app"]['Enums']["actor_kind"],"appointment_id": string,"from_status": Database["app"]['Enums']["appointment_status"] | null,"id": number,"occurred_at": string,"org_id": string,"payload": NonNullable<Json>,"to_status": Database["app"]['Enums']["appointment_status"],"type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"actor_kind": Database["app"]['Enums']["actor_kind"],"appointment_id": string,"from_status"?: Database["app"]['Enums']["appointment_status"] | null,"id"?: never,"occurred_at"?: string,"org_id": string,"payload"?: NonNullable<Json>,"to_status": Database["app"]['Enums']["appointment_status"],"type": string
                  }
                  Update: {
                    "actor_id"?: string | null,"actor_kind"?: Database["app"]['Enums']["actor_kind"],"appointment_id"?: string,"from_status"?: Database["app"]['Enums']["appointment_status"] | null,"id"?: never,"occurred_at"?: string,"org_id"?: string,"payload"?: NonNullable<Json>,"to_status"?: Database["app"]['Enums']["appointment_status"],"type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointment_events_org_id_appointment_id_fkey"
      columns: ["org_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"appointment_manage_tokens": {
                  Row: {
                    "appointment_id": string,"created_at": string,"id": string,"notification_id": string,"org_id": string,"token_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "appointment_id": string,"created_at"?: string,"id"?: string,"notification_id": string,"org_id": string,"token_hash": string
                  }
                  Update: {
                    "appointment_id"?: string,"created_at"?: string,"id"?: string,"notification_id"?: string,"org_id"?: string,"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointment_manage_tokens_org_id_appointment_id_fkey"
      columns: ["org_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "appointment_manage_tokens_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"appointment_series": {
                  Row: {
                    "conflict_dates": NonNullable<Json>,"created_at": string,"created_by": string | null,"guest_id": string | null,"id": string,"idempotency_key": string,"location_id": string,"org_id": string,"rule": NonNullable<Json>,"service_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "conflict_dates"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"guest_id"?: string | null,"id"?: string,"idempotency_key": string,"location_id": string,"org_id": string,"rule": NonNullable<Json>,"service_id": string
                  }
                  Update: {
                    "conflict_dates"?: NonNullable<Json>,"created_at"?: string,"created_by"?: string | null,"guest_id"?: string | null,"id"?: string,"idempotency_key"?: string,"location_id"?: string,"org_id"?: string,"rule"?: NonNullable<Json>,"service_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointment_series_org_id_guest_id_fkey"
      columns: ["org_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "appointment_series_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "appointment_series_org_id_service_id_fkey"
      columns: ["org_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"appointment_slot_counts": {
                  Row: {
                    "count": number,"org_id": string,"service_id": string,"slot_start": string
                  }
                  ComputedFields: never
                  Insert: {
                    "count"?: number,"org_id": string,"service_id": string,"slot_start": string
                  }
                  Update: {
                    "count"?: number,"org_id"?: string,"service_id"?: string,"slot_start"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointment_slot_counts_org_id_service_id_fkey"
      columns: ["org_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"appointments": {
                  Row: {
                    "anonymized_at": string | null,"cancelled_reason": string | null,"contact_id": string | null,"created_at": string,"ends_at": string,"event_id": string | null,"guest_email": string | null,"guest_id": string | null,"guest_name": string,"guest_phone_e164": string | null,"guest_token_hash": string | null,"id": string,"idempotency_key": string,"local_date": string,"locale": string | null,"location_id": string,"org_id": string,"payment_due_at": string | null,"queue_id": string,"seats": number,"series_id": string | null,"service_id": string,"source": string,"staff_user_id": string | null,"starts_at": string,"status": Database["app"]['Enums']["appointment_status"],"version": number,"visit_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "anonymized_at"?: string | null,"cancelled_reason"?: string | null,"contact_id"?: string | null,"created_at"?: string,"ends_at": string,"event_id"?: string | null,"guest_email"?: string | null,"guest_id"?: string | null,"guest_name": string,"guest_phone_e164"?: string | null,"guest_token_hash"?: string | null,"id"?: string,"idempotency_key": string,"local_date": string,"locale"?: string | null,"location_id": string,"org_id": string,"payment_due_at"?: string | null,"queue_id": string,"seats"?: number,"series_id"?: string | null,"service_id": string,"source": string,"staff_user_id"?: string | null,"starts_at": string,"status"?: Database["app"]['Enums']["appointment_status"],"version"?: number,"visit_id"?: string | null
                  }
                  Update: {
                    "anonymized_at"?: string | null,"cancelled_reason"?: string | null,"contact_id"?: string | null,"created_at"?: string,"ends_at"?: string,"event_id"?: string | null,"guest_email"?: string | null,"guest_id"?: string | null,"guest_name"?: string,"guest_phone_e164"?: string | null,"guest_token_hash"?: string | null,"id"?: string,"idempotency_key"?: string,"local_date"?: string,"locale"?: string | null,"location_id"?: string,"org_id"?: string,"payment_due_at"?: string | null,"queue_id"?: string,"seats"?: number,"series_id"?: string | null,"service_id"?: string,"source"?: string,"staff_user_id"?: string | null,"starts_at"?: string,"status"?: Database["app"]['Enums']["appointment_status"],"version"?: number,"visit_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "appointments_event_fk"
      columns: ["org_id","event_id"]
isOneToOne: false
      referencedRelation: "events"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "appointments_org_id_guest_id_fkey"
      columns: ["org_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "appointments_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "appointments_org_id_queue_id_fkey"
      columns: ["org_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "appointments_org_id_service_id_fkey"
      columns: ["org_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "appointments_org_id_staff_user_id_fkey"
      columns: ["org_id","staff_user_id"]
isOneToOne: false
      referencedRelation: "memberships"
      referencedColumns: ["org_id","user_id"]
    },{
      foreignKeyName: "appointments_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "appointments_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "appointments_series_fk"
      columns: ["org_id","series_id"]
isOneToOne: false
      referencedRelation: "appointment_series"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"audit_log": {
                  Row: {
                    "action": string,"actor": string | null,"after": Json | null,"at": string,"before": Json | null,"id": number,"org_id": string,"role": string | null,"row_id": string | null,"support_grant_id": string | null,"table_name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor"?: string | null,"after"?: Json | null,"at"?: string,"before"?: Json | null,"id"?: never,"org_id": string,"role"?: string | null,"row_id"?: string | null,"support_grant_id"?: string | null,"table_name": string
                  }
                  Update: {
                    "action"?: string,"actor"?: string | null,"after"?: Json | null,"at"?: string,"before"?: Json | null,"id"?: never,"org_id"?: string,"role"?: string | null,"row_id"?: string | null,"support_grant_id"?: string | null,"table_name"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "audit_log_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"availability_exceptions": {
                  Row: {
                    "ends": string | null,"id": string,"kind": Database["app"]['Enums']["availability_kind"],"local_date": string,"location_id": string,"note": string | null,"org_id": string,"staff_user_id": string | null,"starts": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "ends"?: string | null,"id"?: string,"kind": Database["app"]['Enums']["availability_kind"],"local_date": string,"location_id": string,"note"?: string | null,"org_id": string,"staff_user_id"?: string | null,"starts"?: string | null
                  }
                  Update: {
                    "ends"?: string | null,"id"?: string,"kind"?: Database["app"]['Enums']["availability_kind"],"local_date"?: string,"location_id"?: string,"note"?: string | null,"org_id"?: string,"staff_user_id"?: string | null,"starts"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "availability_exceptions_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "availability_exceptions_org_id_staff_user_id_fkey"
      columns: ["org_id","staff_user_id"]
isOneToOne: false
      referencedRelation: "memberships"
      referencedColumns: ["org_id","user_id"]
    }
                  ]
                },"availability_rules": {
                  Row: {
                    "ends": string,"id": string,"location_id": string,"org_id": string,"service_id": string | null,"staff_user_id": string | null,"starts": string,"valid_from": string | null,"valid_to": string | null,"weekday": number
                  }
                  ComputedFields: never
                  Insert: {
                    "ends": string,"id"?: string,"location_id": string,"org_id": string,"service_id"?: string | null,"staff_user_id"?: string | null,"starts": string,"valid_from"?: string | null,"valid_to"?: string | null,"weekday": number
                  }
                  Update: {
                    "ends"?: string,"id"?: string,"location_id"?: string,"org_id"?: string,"service_id"?: string | null,"staff_user_id"?: string | null,"starts"?: string,"valid_from"?: string | null,"valid_to"?: string | null,"weekday"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "availability_rules_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "availability_rules_org_id_service_id_fkey"
      columns: ["org_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "availability_rules_org_id_staff_user_id_fkey"
      columns: ["org_id","staff_user_id"]
isOneToOne: false
      referencedRelation: "memberships"
      referencedColumns: ["org_id","user_id"]
    }
                  ]
                },"billing_jobs": {
                  Row: {
                    "attempts": number,"created_at": string,"id": string,"last_error": string | null,"locked_until": string | null,"next_attempt_at": string,"org_id": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"created_at"?: string,"id"?: string,"last_error"?: string | null,"locked_until"?: string | null,"next_attempt_at"?: string,"org_id": string,"status"?: string
                  }
                  Update: {
                    "attempts"?: number,"created_at"?: string,"id"?: string,"last_error"?: string | null,"locked_until"?: string | null,"next_attempt_at"?: string,"org_id"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "billing_jobs_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"blocked_identities": {
                  Row: {
                    "created_at": string,"created_by": string | null,"expires_at": string | null,"id": string,"kind": string,"org_id": string,"queue_id": string | null,"reason": string,"value_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"expires_at"?: string | null,"id"?: string,"kind": string,"org_id": string,"queue_id"?: string | null,"reason": string,"value_hash": string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"expires_at"?: string | null,"id"?: string,"kind"?: string,"org_id"?: string,"queue_id"?: string | null,"reason"?: string,"value_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "blocked_identities_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "blocked_identities_org_id_queue_id_fkey"
      columns: ["org_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"booking_policies": {
                  Row: {
                    "bookable": boolean,"buffer_after_minutes": number,"buffer_before_minutes": number,"created_at": string,"duration_minutes": number | null,"id": string,"location_id": string,"max_days_ahead": number,"min_notice_minutes": number,"org_id": string,"service_id": string,"slot_minutes": number,"slot_offset_minutes": number,"updated_at": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "bookable"?: boolean,"buffer_after_minutes"?: number,"buffer_before_minutes"?: number,"created_at"?: string,"duration_minutes"?: number | null,"id"?: string,"location_id": string,"max_days_ahead"?: number,"min_notice_minutes"?: number,"org_id": string,"service_id": string,"slot_minutes"?: number,"slot_offset_minutes"?: number,"updated_at"?: string,"version"?: number
                  }
                  Update: {
                    "bookable"?: boolean,"buffer_after_minutes"?: number,"buffer_before_minutes"?: number,"created_at"?: string,"duration_minutes"?: number | null,"id"?: string,"location_id"?: string,"max_days_ahead"?: number,"min_notice_minutes"?: number,"org_id"?: string,"service_id"?: string,"slot_minutes"?: number,"slot_offset_minutes"?: number,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "booking_policies_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "booking_policies_org_id_service_id_fkey"
      columns: ["org_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"business_hours": {
                  Row: {
                    "closes": string,"id": string,"location_id": string,"opens": string,"org_id": string,"weekday": number
                  }
                  ComputedFields: never
                  Insert: {
                    "closes": string,"id"?: string,"location_id": string,"opens": string,"org_id": string,"weekday": number
                  }
                  Update: {
                    "closes"?: string,"id"?: string,"location_id"?: string,"opens"?: string,"org_id"?: string,"weekday"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "business_hours_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"calendar_feeds": {
                  Row: {
                    "created_at": string,"id": string,"include_guest_names": boolean,"last_accessed_at": string | null,"org_id": string,"revoked_at": string | null,"token_hash": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"include_guest_names"?: boolean,"last_accessed_at"?: string | null,"org_id": string,"revoked_at"?: string | null,"token_hash": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"include_guest_names"?: boolean,"last_accessed_at"?: string | null,"org_id"?: string,"revoked_at"?: string | null,"token_hash"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "calendar_feeds_org_id_user_id_fkey"
      columns: ["org_id","user_id"]
isOneToOne: false
      referencedRelation: "memberships"
      referencedColumns: ["org_id","user_id"]
    }
                  ]
                },"capacity_rules": {
                  Row: {
                    "capacity": number,"id": string,"local_date": string | null,"location_id": string,"org_id": string,"scope": Database["app"]['Enums']["capacity_scope"],"service_id": string,"weekday": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "capacity": number,"id"?: string,"local_date"?: string | null,"location_id": string,"org_id": string,"scope": Database["app"]['Enums']["capacity_scope"],"service_id": string,"weekday"?: number | null
                  }
                  Update: {
                    "capacity"?: number,"id"?: string,"local_date"?: string | null,"location_id"?: string,"org_id"?: string,"scope"?: Database["app"]['Enums']["capacity_scope"],"service_id"?: string,"weekday"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "capacity_rules_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "capacity_rules_org_id_service_id_fkey"
      columns: ["org_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"channel_limits": {
                  Row: {
                    "channel": Database["app"]['Enums']["notification_channel"],"country_allowlist": (string)[],"daily_cap": number,"monthly_budget_micros": number | null,"org_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "channel": Database["app"]['Enums']["notification_channel"],"country_allowlist"?: (string)[],"daily_cap"?: number,"monthly_budget_micros"?: number | null,"org_id": string,"updated_at"?: string
                  }
                  Update: {
                    "channel"?: Database["app"]['Enums']["notification_channel"],"country_allowlist"?: (string)[],"daily_cap"?: number,"monthly_budget_micros"?: number | null,"org_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "channel_limits_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"channel_link_codes": {
                  Row: {
                    "channel": string,"code_hash": string,"contact_id": string | null,"created_at": string,"expires_at": string,"org_id": string,"used_at": string | null,"visit_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "channel": string,"code_hash": string,"contact_id"?: string | null,"created_at"?: string,"expires_at": string,"org_id": string,"used_at"?: string | null,"visit_id": string
                  }
                  Update: {
                    "channel"?: string,"code_hash"?: string,"contact_id"?: string | null,"created_at"?: string,"expires_at"?: string,"org_id"?: string,"used_at"?: string | null,"visit_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "channel_link_codes_org_id_contact_id_fkey"
      columns: ["org_id","contact_id"]
isOneToOne: false
      referencedRelation: "guest_contacts"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "channel_link_codes_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "channel_link_codes_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"consent_texts": {
                  Row: {
                    "body": string,"channel": Database["app"]['Enums']["notification_channel"],"id": string,"locale": string,"published_at": string,"purpose": Database["app"]['Enums']["message_category"],"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"channel": Database["app"]['Enums']["notification_channel"],"id"?: string,"locale": string,"published_at"?: string,"purpose": Database["app"]['Enums']["message_category"],"version": number
                  }
                  Update: {
                    "body"?: string,"channel"?: Database["app"]['Enums']["notification_channel"],"id"?: string,"locale"?: string,"published_at"?: string,"purpose"?: Database["app"]['Enums']["message_category"],"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"consents": {
                  Row: {
                    "attestation_text_version": number | null,"attested_at": string | null,"captured_at": string,"captured_by_user_id": string | null,"channel": Database["app"]['Enums']["notification_channel"],"consent_text_hash": string,"consent_text_version": string,"contact_id": string | null,"contact_value_sha256": string | null,"id": string,"locale": string | null,"org_id": string,"purpose": Database["app"]['Enums']["message_category"],"revoked_at": string | null,"revoked_via": string | null,"source": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attestation_text_version"?: number | null,"attested_at"?: string | null,"captured_at"?: string,"captured_by_user_id"?: string | null,"channel": Database["app"]['Enums']["notification_channel"],"consent_text_hash": string,"consent_text_version": string,"contact_id"?: string | null,"contact_value_sha256"?: string | null,"id"?: string,"locale"?: string | null,"org_id": string,"purpose": Database["app"]['Enums']["message_category"],"revoked_at"?: string | null,"revoked_via"?: string | null,"source": string,"status": string
                  }
                  Update: {
                    "attestation_text_version"?: number | null,"attested_at"?: string | null,"captured_at"?: string,"captured_by_user_id"?: string | null,"channel"?: Database["app"]['Enums']["notification_channel"],"consent_text_hash"?: string,"consent_text_version"?: string,"contact_id"?: string | null,"contact_value_sha256"?: string | null,"id"?: string,"locale"?: string | null,"org_id"?: string,"purpose"?: Database["app"]['Enums']["message_category"],"revoked_at"?: string | null,"revoked_via"?: string | null,"source"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "consents_org_id_contact_id_fkey"
      columns: ["org_id","contact_id"]
isOneToOne: false
      referencedRelation: "guest_contacts"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"counters": {
                  Row: {
                    "active": boolean,"archived_at": string | null,"created_at": string,"id": string,"kind": Database["app"]['Enums']["resource_kind"],"label": string,"location_id": string,"member_user_id": string | null,"org_id": string,"seats": number | null,"sort_order": number
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"archived_at"?: string | null,"created_at"?: string,"id"?: string,"kind"?: Database["app"]['Enums']["resource_kind"],"label": string,"location_id": string,"member_user_id"?: string | null,"org_id": string,"seats"?: number | null,"sort_order"?: number
                  }
                  Update: {
                    "active"?: boolean,"archived_at"?: string | null,"created_at"?: string,"id"?: string,"kind"?: Database["app"]['Enums']["resource_kind"],"label"?: string,"location_id"?: string,"member_user_id"?: string | null,"org_id"?: string,"seats"?: number | null,"sort_order"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "counters_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"credit_ledger": {
                  Row: {
                    "amount_micros": number,"cost_micros": number,"created_at": string,"entry_type": string,"id": string,"margin_micros": number,"notification_id": string | null,"org_id": string,"stripe_ref": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_micros": number,"cost_micros"?: number,"created_at"?: string,"entry_type": string,"id"?: string,"margin_micros"?: number,"notification_id"?: string | null,"org_id": string,"stripe_ref"?: string | null
                  }
                  Update: {
                    "amount_micros"?: number,"cost_micros"?: number,"created_at"?: string,"entry_type"?: string,"id"?: string,"margin_micros"?: number,"notification_id"?: string | null,"org_id"?: string,"stripe_ref"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "credit_ledger_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"custom_domains": {
                  Row: {
                    "created_at": string,"default_location_id": string,"failed_checks": number,"hostname": string,"id": string,"last_checked_at": string | null,"org_id": string,"status": string,"verification_token": string,"verified_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"default_location_id": string,"failed_checks"?: number,"hostname": string,"id"?: string,"last_checked_at"?: string | null,"org_id": string,"status"?: string,"verification_token"?: string,"verified_at"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"default_location_id"?: string,"failed_checks"?: number,"hostname"?: string,"id"?: string,"last_checked_at"?: string | null,"org_id"?: string,"status"?: string,"verification_token"?: string,"verified_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "custom_domains_org_id_default_location_id_fkey"
      columns: ["org_id","default_location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "custom_domains_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"custom_roles": {
                  Row: {
                    "created_at": string,"id": string,"name": string,"org_id": string,"permissions": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"name": string,"org_id": string,"permissions"?: (string)[]
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"name"?: string,"org_id"?: string,"permissions"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "custom_roles_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"data_exports": {
                  Row: {
                    "actor": string,"created_at": string,"expires_at": string,"format": string,"id": string,"idempotency_key": string,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor": string,"created_at"?: string,"expires_at": string,"format": string,"id"?: string,"idempotency_key": string,"org_id": string
                  }
                  Update: {
                    "actor"?: string,"created_at"?: string,"expires_at"?: string,"format"?: string,"id"?: string,"idempotency_key"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "data_exports_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"dev_inbox": {
                  Row: {
                    "body": string,"channel": Database["app"]['Enums']["notification_channel"],"created_at": string,"encoding": string | null,"id": number,"notification_id": string | null,"org_id": string,"recipient": string,"segments": number | null,"subject": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"channel": Database["app"]['Enums']["notification_channel"],"created_at"?: string,"encoding"?: string | null,"id"?: never,"notification_id"?: string | null,"org_id": string,"recipient": string,"segments"?: number | null,"subject"?: string | null
                  }
                  Update: {
                    "body"?: string,"channel"?: Database["app"]['Enums']["notification_channel"],"created_at"?: string,"encoding"?: string | null,"id"?: never,"notification_id"?: string | null,"org_id"?: string,"recipient"?: string,"segments"?: number | null,"subject"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "dev_inbox_notification_id_fkey"
      columns: ["notification_id"]
isOneToOne: false
      referencedRelation: "notifications"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "dev_inbox_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"device_pairing_codes": {
                  Row: {
                    "code_hash": string,"created_at": string,"created_by": string | null,"device_id": string | null,"expires_at": string,"id": string,"kind": Database["app"]['Enums']["device_kind"],"location_id": string,"name": string,"org_id": string,"used_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "code_hash": string,"created_at"?: string,"created_by"?: string | null,"device_id"?: string | null,"expires_at": string,"id"?: string,"kind": Database["app"]['Enums']["device_kind"],"location_id": string,"name"?: string,"org_id": string,"used_at"?: string | null
                  }
                  Update: {
                    "code_hash"?: string,"created_at"?: string,"created_by"?: string | null,"device_id"?: string | null,"expires_at"?: string,"id"?: string,"kind"?: Database["app"]['Enums']["device_kind"],"location_id"?: string,"name"?: string,"org_id"?: string,"used_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "device_pairing_codes_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"devices": {
                  Row: {
                    "app_version": string | null,"auth_user_id": string | null,"counter_id": string | null,"created_at": string,"id": string,"kind": Database["app"]['Enums']["device_kind"],"last_drop_at": string | null,"last_seen_at": string | null,"location_id": string,"name": string,"org_id": string,"realtime_drops": number,"revoked_at": string | null,"scopes": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "app_version"?: string | null,"auth_user_id"?: string | null,"counter_id"?: string | null,"created_at"?: string,"id"?: string,"kind": Database["app"]['Enums']["device_kind"],"last_drop_at"?: string | null,"last_seen_at"?: string | null,"location_id": string,"name"?: string,"org_id": string,"realtime_drops"?: number,"revoked_at"?: string | null,"scopes"?: (string)[]
                  }
                  Update: {
                    "app_version"?: string | null,"auth_user_id"?: string | null,"counter_id"?: string | null,"created_at"?: string,"id"?: string,"kind"?: Database["app"]['Enums']["device_kind"],"last_drop_at"?: string | null,"last_seen_at"?: string | null,"location_id"?: string,"name"?: string,"org_id"?: string,"realtime_drops"?: number,"revoked_at"?: string | null,"scopes"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "devices_counter_fk"
      columns: ["org_id","location_id","counter_id"]
isOneToOne: false
      referencedRelation: "counters"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "devices_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"dial_codes": {
                  Row: {
                    "country_code": string,"prefix": string
                  }
                  ComputedFields: never
                  Insert: {
                    "country_code": string,"prefix": string
                  }
                  Update: {
                    "country_code"?: string,"prefix"?: string
                  }
                  Relationships: [
                    
                  ]
                },"entitlement_defaults": {
                  Row: {
                    "description": string,"key": string,"value": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "description": string,"key": string,"value": NonNullable<Json>
                  }
                  Update: {
                    "description"?: string,"key"?: string,"value"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"events": {
                  Row: {
                    "booked": number,"capacity": number,"created_at": string,"during": unknown,"id": string,"location_id": string,"org_id": string,"public": boolean,"service_id": string,"status": Database["app"]['Enums']["event_status"],"title": string
                  }
                  ComputedFields: never
                  Insert: {
                    "booked"?: number,"capacity": number,"created_at"?: string,"during": unknown,"id"?: string,"location_id": string,"org_id": string,"public"?: boolean,"service_id": string,"status"?: Database["app"]['Enums']["event_status"],"title": string
                  }
                  Update: {
                    "booked"?: number,"capacity"?: number,"created_at"?: string,"during"?: unknown,"id"?: string,"location_id"?: string,"org_id"?: string,"public"?: boolean,"service_id"?: string,"status"?: Database["app"]['Enums']["event_status"],"title"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "events_org_id_location_id_service_id_fkey"
      columns: ["org_id","location_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"form_responses": {
                  Row: {
                    "answers": NonNullable<Json>,"appointment_id": string | null,"created_at": string,"form_version_id": string,"id": string,"location_id": string,"org_id": string,"updated_at": string,"visit_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "answers"?: NonNullable<Json>,"appointment_id"?: string | null,"created_at"?: string,"form_version_id": string,"id"?: string,"location_id": string,"org_id": string,"updated_at"?: string,"visit_id"?: string | null
                  }
                  Update: {
                    "answers"?: NonNullable<Json>,"appointment_id"?: string | null,"created_at"?: string,"form_version_id"?: string,"id"?: string,"location_id"?: string,"org_id"?: string,"updated_at"?: string,"visit_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "form_responses_org_id_form_version_id_fkey"
      columns: ["org_id","form_version_id"]
isOneToOne: false
      referencedRelation: "form_versions"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "form_responses_org_id_location_id_appointment_id_fkey"
      columns: ["org_id","location_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "form_responses_org_id_location_id_visit_id_fkey"
      columns: ["org_id","location_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "form_responses_org_id_location_id_visit_id_fkey"
      columns: ["org_id","location_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"form_targets": {
                  Row: {
                    "channel": string,"created_at": string,"form_id": string,"id": string,"location_id": string,"org_id": string,"queue_id": string | null,"service_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "channel"?: string,"created_at"?: string,"form_id": string,"id"?: string,"location_id": string,"org_id": string,"queue_id"?: string | null,"service_id"?: string | null
                  }
                  Update: {
                    "channel"?: string,"created_at"?: string,"form_id"?: string,"id"?: string,"location_id"?: string,"org_id"?: string,"queue_id"?: string | null,"service_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "form_targets_org_id_location_id_form_id_fkey"
      columns: ["org_id","location_id","form_id"]
isOneToOne: false
      referencedRelation: "forms"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "form_targets_org_id_location_id_queue_id_fkey"
      columns: ["org_id","location_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "form_targets_org_id_location_id_service_id_fkey"
      columns: ["org_id","location_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"form_versions": {
                  Row: {
                    "created_at": string,"fields": NonNullable<Json>,"form_id": string,"id": string,"location_id": string,"org_id": string,"published_at": string | null,"text_hash": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"fields"?: NonNullable<Json>,"form_id": string,"id"?: string,"location_id": string,"org_id": string,"published_at"?: string | null,"text_hash"?: string | null,"version": number
                  }
                  Update: {
                    "created_at"?: string,"fields"?: NonNullable<Json>,"form_id"?: string,"id"?: string,"location_id"?: string,"org_id"?: string,"published_at"?: string | null,"text_hash"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "form_versions_org_id_location_id_form_id_fkey"
      columns: ["org_id","location_id","form_id"]
isOneToOne: false
      referencedRelation: "forms"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"forms": {
                  Row: {
                    "created_at": string,"id": string,"is_queue_default": boolean,"location_id": string,"name": string,"org_id": string,"origin_template": string | null,"origin_version": number | null,"purpose_text": string | null,"retention_days": number | null,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"is_queue_default"?: boolean,"location_id": string,"name": string,"org_id": string,"origin_template"?: string | null,"origin_version"?: number | null,"purpose_text"?: string | null,"retention_days"?: number | null,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"is_queue_default"?: boolean,"location_id"?: string,"name"?: string,"org_id"?: string,"origin_template"?: string | null,"origin_version"?: number | null,"purpose_text"?: string | null,"retention_days"?: number | null,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "forms_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"guest_contacts": {
                  Row: {
                    "channel": Database["app"]['Enums']["contact_channel"],"country_code": string | null,"created_at": string,"created_source": string,"guest_id": string,"id": string,"org_id": string,"value": string,"verified_at": string | null,"whatsapp_window_until": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "channel": Database["app"]['Enums']["contact_channel"],"country_code"?: string | null,"created_at"?: string,"created_source": string,"guest_id": string,"id"?: string,"org_id": string,"value": string,"verified_at"?: string | null,"whatsapp_window_until"?: string | null
                  }
                  Update: {
                    "channel"?: Database["app"]['Enums']["contact_channel"],"country_code"?: string | null,"created_at"?: string,"created_source"?: string,"guest_id"?: string,"id"?: string,"org_id"?: string,"value"?: string,"verified_at"?: string | null,"whatsapp_window_until"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "guest_contacts_org_id_guest_id_fkey"
      columns: ["org_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"guest_notes": {
                  Row: {
                    "author_user_id": string | null,"body": string,"created_at": string,"deleted_at": string | null,"guest_id": string,"id": string,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "author_user_id"?: string | null,"body": string,"created_at"?: string,"deleted_at"?: string | null,"guest_id": string,"id"?: string,"org_id": string
                  }
                  Update: {
                    "author_user_id"?: string | null,"body"?: string,"created_at"?: string,"deleted_at"?: string | null,"guest_id"?: string,"id"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guest_notes_org_id_guest_id_fkey"
      columns: ["org_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"guest_notices": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"body": string,"created_at": string,"created_by": string | null,"id": string,"location_id": string | null,"log_id": string,"org_id": string,"recipient_count": number | null,"sent_at": string | null,"sent_by": string | null,"status": string,"subject": string,"updated_at": string,"window_from": string,"window_to": string
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"body": string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"location_id"?: string | null,"log_id": string,"org_id": string,"recipient_count"?: number | null,"sent_at"?: string | null,"sent_by"?: string | null,"status"?: string,"subject": string,"updated_at"?: string,"window_from": string,"window_to": string
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"body"?: string,"created_at"?: string,"created_by"?: string | null,"id"?: string,"location_id"?: string | null,"log_id"?: string,"org_id"?: string,"recipient_count"?: number | null,"sent_at"?: string | null,"sent_by"?: string | null,"status"?: string,"subject"?: string,"updated_at"?: string,"window_from"?: string,"window_to"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guest_notices_log_id_fkey"
      columns: ["log_id"]
isOneToOne: false
      referencedRelation: "org_incident_log"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "guest_notices_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "guest_notices_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"guest_tag_links": {
                  Row: {
                    "created_at": string,"guest_id": string,"org_id": string,"tag_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"guest_id": string,"org_id": string,"tag_id": string
                  }
                  Update: {
                    "created_at"?: string,"guest_id"?: string,"org_id"?: string,"tag_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guest_tag_links_org_id_guest_id_fkey"
      columns: ["org_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "guest_tag_links_org_id_tag_id_fkey"
      columns: ["org_id","tag_id"]
isOneToOne: false
      referencedRelation: "guest_tags"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"guest_tags": {
                  Row: {
                    "color": string | null,"created_at": string,"id": string,"name": string,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "color"?: string | null,"created_at"?: string,"id"?: string,"name": string,"org_id": string
                  }
                  Update: {
                    "color"?: string | null,"created_at"?: string,"id"?: string,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guest_tags_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"guests": {
                  Row: {
                    "anonymized_at": string | null,"created_at": string,"first_name": string | null,"id": string,"merged_into_id": string | null,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "anonymized_at"?: string | null,"created_at"?: string,"first_name"?: string | null,"id"?: string,"merged_into_id"?: string | null,"org_id": string
                  }
                  Update: {
                    "anonymized_at"?: string | null,"created_at"?: string,"first_name"?: string | null,"id"?: string,"merged_into_id"?: string | null,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guests_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "guests_org_id_merged_into_id_fkey"
      columns: ["org_id","merged_into_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"hours_exceptions": {
                  Row: {
                    "closed": boolean,"closes": string | null,"date": string,"id": string,"location_id": string,"note": string | null,"opens": string | null,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "closed"?: boolean,"closes"?: string | null,"date": string,"id"?: string,"location_id": string,"note"?: string | null,"opens"?: string | null,"org_id": string
                  }
                  Update: {
                    "closed"?: boolean,"closes"?: string | null,"date"?: string,"id"?: string,"location_id"?: string,"note"?: string | null,"opens"?: string | null,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "hours_exceptions_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"idempotency_keys": {
                  Row: {
                    "actor_id": string,"created_at": string,"key": string,"org_id": string,"response": Json | null,"rpc": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id": string,"created_at"?: string,"key": string,"org_id": string,"response"?: Json | null,"rpc": string
                  }
                  Update: {
                    "actor_id"?: string,"created_at"?: string,"key"?: string,"org_id"?: string,"response"?: Json | null,"rpc"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "idempotency_keys_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"inbound_messages": {
                  Row: {
                    "body": string,"channel": Database["app"]['Enums']["notification_channel"],"from_value_e164": string,"handled_as": string | null,"id": number,"matched_contact_id": string | null,"org_id": string,"provider": string | null,"provider_message_id": string | null,"public_id": string,"raw_payload": NonNullable<Json>,"received_at": string,"signature_verified": boolean,"to_address": string | null,"visit_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"channel"?: Database["app"]['Enums']["notification_channel"],"from_value_e164": string,"handled_as"?: string | null,"id"?: never,"matched_contact_id"?: string | null,"org_id": string,"provider"?: string | null,"provider_message_id"?: string | null,"public_id"?: string,"raw_payload"?: NonNullable<Json>,"received_at"?: string,"signature_verified"?: boolean,"to_address"?: string | null,"visit_id"?: string | null
                  }
                  Update: {
                    "body"?: string,"channel"?: Database["app"]['Enums']["notification_channel"],"from_value_e164"?: string,"handled_as"?: string | null,"id"?: never,"matched_contact_id"?: string | null,"org_id"?: string,"provider"?: string | null,"provider_message_id"?: string | null,"public_id"?: string,"raw_payload"?: NonNullable<Json>,"received_at"?: string,"signature_verified"?: boolean,"to_address"?: string | null,"visit_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "inbound_messages_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "inbound_messages_org_id_matched_contact_id_fkey"
      columns: ["org_id","matched_contact_id"]
isOneToOne: false
      referencedRelation: "guest_contacts"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "inbound_messages_visit_fk"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "inbound_messages_visit_fk"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"incident_notices": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"body": string,"created_at": string,"drafted_by": string | null,"id": string,"incident_id": string,"sent_at": string | null,"status": string,"subject": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"body": string,"created_at"?: string,"drafted_by"?: string | null,"id"?: string,"incident_id": string,"sent_at"?: string | null,"status"?: string,"subject": string,"updated_at"?: string
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"body"?: string,"created_at"?: string,"drafted_by"?: string | null,"id"?: string,"incident_id"?: string,"sent_at"?: string | null,"status"?: string,"subject"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "incident_notices_incident_id_fkey"
      columns: ["incident_id"]
isOneToOne: false
      referencedRelation: "platform_incidents"
      referencedColumns: ["id"]
    }
                  ]
                },"intake_fields": {
                  Row: {
                    "active": boolean,"created_at": string,"help": string | null,"id": string,"key": string,"label": string,"location_id": string,"options": Json | null,"org_id": string,"position": number,"queue_id": string,"required": boolean,"retention_days": number | null,"sensitivity": Database["app"]['Enums']["intake_sensitivity"],"type": Database["app"]['Enums']["intake_field_type"],"visibility": Database["app"]['Enums']["intake_visibility"]
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"help"?: string | null,"id"?: string,"key": string,"label": string,"location_id": string,"options"?: Json | null,"org_id": string,"position"?: number,"queue_id": string,"required"?: boolean,"retention_days"?: number | null,"sensitivity"?: Database["app"]['Enums']["intake_sensitivity"],"type": Database["app"]['Enums']["intake_field_type"],"visibility"?: Database["app"]['Enums']["intake_visibility"]
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"help"?: string | null,"id"?: string,"key"?: string,"label"?: string,"location_id"?: string,"options"?: Json | null,"org_id"?: string,"position"?: number,"queue_id"?: string,"required"?: boolean,"retention_days"?: number | null,"sensitivity"?: Database["app"]['Enums']["intake_sensitivity"],"type"?: Database["app"]['Enums']["intake_field_type"],"visibility"?: Database["app"]['Enums']["intake_visibility"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "intake_fields_org_id_location_id_queue_id_fkey"
      columns: ["org_id","location_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"integration_jobs": {
                  Row: {
                    "attempts": number,"created_at": string,"error": string | null,"event_id": string,"id": string,"locked_until": string | null,"next_attempt_at": string,"org_id": string,"setting_id": string,"status": string,"visit_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"created_at"?: string,"error"?: string | null,"event_id": string,"id"?: string,"locked_until"?: string | null,"next_attempt_at"?: string,"org_id": string,"setting_id": string,"status"?: string,"visit_id": string
                  }
                  Update: {
                    "attempts"?: number,"created_at"?: string,"error"?: string | null,"event_id"?: string,"id"?: string,"locked_until"?: string | null,"next_attempt_at"?: string,"org_id"?: string,"setting_id"?: string,"status"?: string,"visit_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "integration_jobs_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "integration_jobs_org_id_setting_id_fkey"
      columns: ["org_id","setting_id"]
isOneToOne: false
      referencedRelation: "provider_settings"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "integration_jobs_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "integration_jobs_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"integration_oauth_states": {
                  Row: {
                    "channel": string,"expires_at": string,"org_id": string,"state_hash": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "channel": string,"expires_at": string,"org_id": string,"state_hash": string,"user_id": string
                  }
                  Update: {
                    "channel"?: string,"expires_at"?: string,"org_id"?: string,"state_hash"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "integration_oauth_states_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"invitations": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"display_name": string | null,"email": string,"expires_at": string,"id": string,"invited_by": string | null,"location_ids": (string)[] | null,"org_id": string,"revoked_at": string | null,"role": Database["app"]['Enums']["member_role"],"token_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"display_name"?: string | null,"email": string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"location_ids"?: (string)[] | null,"org_id": string,"revoked_at"?: string | null,"role": Database["app"]['Enums']["member_role"],"token_hash": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"display_name"?: string | null,"email"?: string,"expires_at"?: string,"id"?: string,"invited_by"?: string | null,"location_ids"?: (string)[] | null,"org_id"?: string,"revoked_at"?: string | null,"role"?: Database["app"]['Enums']["member_role"],"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invitations_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"journey_steps": {
                  Row: {
                    "id": string,"journey_id": string,"org_id": string,"queue_id": string,"service_id": string | null,"step_no": number
                  }
                  ComputedFields: never
                  Insert: {
                    "id"?: string,"journey_id": string,"org_id": string,"queue_id": string,"service_id"?: string | null,"step_no": number
                  }
                  Update: {
                    "id"?: string,"journey_id"?: string,"org_id"?: string,"queue_id"?: string,"service_id"?: string | null,"step_no"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "journey_steps_org_id_journey_id_fkey"
      columns: ["org_id","journey_id"]
isOneToOne: false
      referencedRelation: "journeys"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "journey_steps_org_id_queue_id_fkey"
      columns: ["org_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "journey_steps_service_id_fkey"
      columns: ["service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["id"]
    }
                  ]
                },"journeys": {
                  Row: {
                    "active": boolean,"created_at": string,"id": string,"location_id": string,"name": string,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"created_at"?: string,"id"?: string,"location_id": string,"name": string,"org_id": string
                  }
                  Update: {
                    "active"?: boolean,"created_at"?: string,"id"?: string,"location_id"?: string,"name"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "journeys_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"locations": {
                  Row: {
                    "address": string | null,"announce_locales": (string)[],"announce_repeat": number,"announce_voice_prefs": NonNullable<Json>,"booking_rate_per_min": number,"contact": string | null,"country_code": string | null,"cover_path": string | null,"created_at": string,"day_boundary": string,"display_names_enabled": boolean,"geofence_m": number,"id": string,"last_rollover_day": string | null,"lat": number | null,"lng": number | null,"name": string,"onsite_code_required": boolean,"onsite_code_rotate_minutes": number,"org_id": string,"print_footer": string | null,"print_paper_mm": number,"privacy_url": string | null,"reminder_offsets_minutes": (number)[],"send_window_end": string,"send_window_start": string,"slug": string,"terms_url": string | null,"tz": string,"updated_at": string,"waitlist_hold_minutes": number,"welcome_text": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "address"?: string | null,"announce_locales"?: (string)[],"announce_repeat"?: number,"announce_voice_prefs"?: NonNullable<Json>,"booking_rate_per_min"?: number,"contact"?: string | null,"country_code"?: string | null,"cover_path"?: string | null,"created_at"?: string,"day_boundary"?: string,"display_names_enabled"?: boolean,"geofence_m"?: number,"id"?: string,"last_rollover_day"?: string | null,"lat"?: number | null,"lng"?: number | null,"name": string,"onsite_code_required"?: boolean,"onsite_code_rotate_minutes"?: number,"org_id": string,"print_footer"?: string | null,"print_paper_mm"?: number,"privacy_url"?: string | null,"reminder_offsets_minutes"?: (number)[],"send_window_end"?: string,"send_window_start"?: string,"slug": string,"terms_url"?: string | null,"tz": string,"updated_at"?: string,"waitlist_hold_minutes"?: number,"welcome_text"?: string | null
                  }
                  Update: {
                    "address"?: string | null,"announce_locales"?: (string)[],"announce_repeat"?: number,"announce_voice_prefs"?: NonNullable<Json>,"booking_rate_per_min"?: number,"contact"?: string | null,"country_code"?: string | null,"cover_path"?: string | null,"created_at"?: string,"day_boundary"?: string,"display_names_enabled"?: boolean,"geofence_m"?: number,"id"?: string,"last_rollover_day"?: string | null,"lat"?: number | null,"lng"?: number | null,"name"?: string,"onsite_code_required"?: boolean,"onsite_code_rotate_minutes"?: number,"org_id"?: string,"print_footer"?: string | null,"print_paper_mm"?: number,"privacy_url"?: string | null,"reminder_offsets_minutes"?: (number)[],"send_window_end"?: string,"send_window_start"?: string,"slug"?: string,"terms_url"?: string | null,"tz"?: string,"updated_at"?: string,"waitlist_hold_minutes"?: number,"welcome_text"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "locations_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"memberships": {
                  Row: {
                    "created_at": string,"custom_role_id": string | null,"display_name": string | null,"id": string,"location_ids": (string)[] | null,"notify_usage_alerts": boolean,"org_id": string,"pin_hash": string | null,"queue_ids": (string)[] | null,"removal_reason": string | null,"role": Database["app"]['Enums']["member_role"],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"custom_role_id"?: string | null,"display_name"?: string | null,"id"?: string,"location_ids"?: (string)[] | null,"notify_usage_alerts"?: boolean,"org_id": string,"pin_hash"?: string | null,"queue_ids"?: (string)[] | null,"removal_reason"?: string | null,"role": Database["app"]['Enums']["member_role"],"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"custom_role_id"?: string | null,"display_name"?: string | null,"id"?: string,"location_ids"?: (string)[] | null,"notify_usage_alerts"?: boolean,"org_id"?: string,"pin_hash"?: string | null,"queue_ids"?: (string)[] | null,"removal_reason"?: string | null,"role"?: Database["app"]['Enums']["member_role"],"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "memberships_custom_role_fk"
      columns: ["org_id","custom_role_id"]
isOneToOne: false
      referencedRelation: "custom_roles"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "memberships_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"notification_template_versions": {
                  Row: {
                    "active": boolean,"body": string,"changed_at": string,"changed_by": string | null,"channel": Database["app"]['Enums']["notification_channel"],"id": number,"locale": string,"org_id": string,"queue_id": string | null,"subject": string | null,"template_id": string,"trigger": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "active": boolean,"body": string,"changed_at"?: string,"changed_by"?: string | null,"channel": Database["app"]['Enums']["notification_channel"],"id"?: never,"locale": string,"org_id": string,"queue_id"?: string | null,"subject"?: string | null,"template_id": string,"trigger": string,"version": number
                  }
                  Update: {
                    "active"?: boolean,"body"?: string,"changed_at"?: string,"changed_by"?: string | null,"channel"?: Database["app"]['Enums']["notification_channel"],"id"?: never,"locale"?: string,"org_id"?: string,"queue_id"?: string | null,"subject"?: string | null,"template_id"?: string,"trigger"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "notification_template_versions_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"notification_templates": {
                  Row: {
                    "active": boolean,"body": string,"category": Database["app"]['Enums']["message_category"],"channel": Database["app"]['Enums']["notification_channel"],"created_at": string,"fallback_after_seconds": number | null,"id": string,"locale": string,"org_id": string | null,"queue_id": string | null,"subject": string | null,"trigger": string,"updated_by": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"body": string,"category"?: Database["app"]['Enums']["message_category"],"channel": Database["app"]['Enums']["notification_channel"],"created_at"?: string,"fallback_after_seconds"?: number | null,"id"?: string,"locale"?: string,"org_id"?: string | null,"queue_id"?: string | null,"subject"?: string | null,"trigger": string,"updated_by"?: string | null,"version"?: number
                  }
                  Update: {
                    "active"?: boolean,"body"?: string,"category"?: Database["app"]['Enums']["message_category"],"channel"?: Database["app"]['Enums']["notification_channel"],"created_at"?: string,"fallback_after_seconds"?: number | null,"id"?: string,"locale"?: string,"org_id"?: string | null,"queue_id"?: string | null,"subject"?: string | null,"trigger"?: string,"updated_by"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "notification_templates_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notification_templates_org_id_queue_id_fkey"
      columns: ["org_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"notifications": {
                  Row: {
                    "appointment_id": string | null,"attempts": number,"category": Database["app"]['Enums']["message_category"],"chain_id": string | null,"chain_step": number,"channel": Database["app"]['Enums']["notification_channel"],"consent_id": string | null,"cost_micros": number | null,"cost_source": string | null,"created_at": string,"currency": string,"dedupe_key": string,"delivered_at": string | null,"delivery_status": string | null,"error_code": string | null,"event_id": number | null,"fallback_at": string | null,"id": string,"locked_until": string | null,"next_attempt_at": string,"org_id": string,"price_checked_at": string | null,"provider": string | null,"provider_message_id": string | null,"quiet_hours_deferred": boolean,"recipient_hash": string | null,"recipient_ref": string,"reserved_at": string | null,"scheduled_for": string | null,"segments": number | null,"sent_at": string | null,"status": Database["app"]['Enums']["notification_status"],"template_key": string,"template_version": number,"updated_at": string,"vars": NonNullable<Json>,"visit_id": string | null,"wa_mode": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "appointment_id"?: string | null,"attempts"?: number,"category"?: Database["app"]['Enums']["message_category"],"chain_id"?: string | null,"chain_step"?: number,"channel": Database["app"]['Enums']["notification_channel"],"consent_id"?: string | null,"cost_micros"?: number | null,"cost_source"?: string | null,"created_at"?: string,"currency"?: string,"dedupe_key": string,"delivered_at"?: string | null,"delivery_status"?: string | null,"error_code"?: string | null,"event_id"?: number | null,"fallback_at"?: string | null,"id"?: string,"locked_until"?: string | null,"next_attempt_at"?: string,"org_id": string,"price_checked_at"?: string | null,"provider"?: string | null,"provider_message_id"?: string | null,"quiet_hours_deferred"?: boolean,"recipient_hash"?: string | null,"recipient_ref": string,"reserved_at"?: string | null,"scheduled_for"?: string | null,"segments"?: number | null,"sent_at"?: string | null,"status"?: Database["app"]['Enums']["notification_status"],"template_key": string,"template_version": number,"updated_at"?: string,"vars"?: NonNullable<Json>,"visit_id"?: string | null,"wa_mode"?: string | null
                  }
                  Update: {
                    "appointment_id"?: string | null,"attempts"?: number,"category"?: Database["app"]['Enums']["message_category"],"chain_id"?: string | null,"chain_step"?: number,"channel"?: Database["app"]['Enums']["notification_channel"],"consent_id"?: string | null,"cost_micros"?: number | null,"cost_source"?: string | null,"created_at"?: string,"currency"?: string,"dedupe_key"?: string,"delivered_at"?: string | null,"delivery_status"?: string | null,"error_code"?: string | null,"event_id"?: number | null,"fallback_at"?: string | null,"id"?: string,"locked_until"?: string | null,"next_attempt_at"?: string,"org_id"?: string,"price_checked_at"?: string | null,"provider"?: string | null,"provider_message_id"?: string | null,"quiet_hours_deferred"?: boolean,"recipient_hash"?: string | null,"recipient_ref"?: string,"reserved_at"?: string | null,"scheduled_for"?: string | null,"segments"?: number | null,"sent_at"?: string | null,"status"?: Database["app"]['Enums']["notification_status"],"template_key"?: string,"template_version"?: number,"updated_at"?: string,"vars"?: NonNullable<Json>,"visit_id"?: string | null,"wa_mode"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "notifications_appointment_fk"
      columns: ["org_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "notifications_consent_id_fkey"
      columns: ["consent_id"]
isOneToOne: false
      referencedRelation: "consents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notifications_event_id_fkey"
      columns: ["event_id"]
isOneToOne: false
      referencedRelation: "visit_events"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "notifications_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "notifications_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"operator_sessions": {
                  Row: {
                    "created_at": string,"device_user_id": string,"ended_at": string | null,"expires_at": string,"id": string,"location_id": string,"operator_user_id": string,"org_id": string,"token_hash": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"device_user_id": string,"ended_at"?: string | null,"expires_at"?: string,"id"?: string,"location_id": string,"operator_user_id": string,"org_id": string,"token_hash": string
                  }
                  Update: {
                    "created_at"?: string,"device_user_id"?: string,"ended_at"?: string | null,"expires_at"?: string,"id"?: string,"location_id"?: string,"operator_user_id"?: string,"org_id"?: string,"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "operator_sessions_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"org_entitlements": {
                  Row: {
                    "key": string,"org_id": string,"reason": string,"set_at": string,"set_by": string | null,"value": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "key": string,"org_id": string,"reason": string,"set_at"?: string,"set_by"?: string | null,"value": NonNullable<Json>
                  }
                  Update: {
                    "key"?: string,"org_id"?: string,"reason"?: string,"set_at"?: string,"set_by"?: string | null,"value"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "org_entitlements_key_fkey"
      columns: ["key"]
isOneToOne: false
      referencedRelation: "entitlement_defaults"
      referencedColumns: ["key"]
    },{
      foreignKeyName: "org_entitlements_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"org_incident_log": {
                  Row: {
                    "acknowledged_at": string | null,"acknowledged_by": string | null,"actions_taken": string | null,"created_at": string,"created_by": string | null,"data_categories": (string)[],"description": string | null,"detected_at": string,"id": string,"incident_id": string | null,"kind": string,"notice_body": string | null,"notice_id": string | null,"notice_sent_at": string | null,"notice_subject": string | null,"org_id": string,"people_affected": number | null,"regulator_notified": string | null,"source": string,"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "acknowledged_at"?: string | null,"acknowledged_by"?: string | null,"actions_taken"?: string | null,"created_at"?: string,"created_by"?: string | null,"data_categories"?: (string)[],"description"?: string | null,"detected_at": string,"id"?: string,"incident_id"?: string | null,"kind": string,"notice_body"?: string | null,"notice_id"?: string | null,"notice_sent_at"?: string | null,"notice_subject"?: string | null,"org_id": string,"people_affected"?: number | null,"regulator_notified"?: string | null,"source": string,"title": string,"updated_at"?: string
                  }
                  Update: {
                    "acknowledged_at"?: string | null,"acknowledged_by"?: string | null,"actions_taken"?: string | null,"created_at"?: string,"created_by"?: string | null,"data_categories"?: (string)[],"description"?: string | null,"detected_at"?: string,"id"?: string,"incident_id"?: string | null,"kind"?: string,"notice_body"?: string | null,"notice_id"?: string | null,"notice_sent_at"?: string | null,"notice_subject"?: string | null,"org_id"?: string,"people_affected"?: number | null,"regulator_notified"?: string | null,"source"?: string,"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "org_incident_log_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"org_privacy": {
                  Row: {
                    "email": string,"jurisdiction": string,"notice_prefs": NonNullable<Json>,"officer_name": string,"org_id": string,"phone": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "email": string,"jurisdiction": string,"notice_prefs"?: NonNullable<Json>,"officer_name": string,"org_id": string,"phone"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "email"?: string,"jurisdiction"?: string,"notice_prefs"?: NonNullable<Json>,"officer_name"?: string,"org_id"?: string,"phone"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "org_privacy_org_id_fkey"
      columns: ["org_id"]
isOneToOne: true
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"organizations": {
                  Row: {
                    "brand_accent": string | null,"brand_primary": string | null,"created_at": string,"created_by": string | null,"default_locale": string,"deletion_requested_at": string | null,"deletion_scheduled_for": string | null,"external_purged_at": string | null,"feedback_ask_nps": boolean,"feedback_enabled": boolean,"feedback_include_no_show": boolean,"health_tagged": boolean,"hide_product_branding": boolean,"id": string,"legal_name": string | null,"logo_path": string | null,"name": string,"postal_address": string | null,"require_mfa_for_admins": boolean,"retention_days": number,"scope_staff_to_lines": boolean,"single_active_visit": Database["app"]['Enums']["single_active_scope"],"status": Database["app"]['Enums']["org_status"],"support_contact": string | null,"suspended_at": string | null,"suspended_by": string | null,"suspended_reason": string | null,"updated_at": string,"waiver_retention_days": number
                  }
                  ComputedFields: never
                  Insert: {
                    "brand_accent"?: string | null,"brand_primary"?: string | null,"created_at"?: string,"created_by"?: string | null,"default_locale"?: string,"deletion_requested_at"?: string | null,"deletion_scheduled_for"?: string | null,"external_purged_at"?: string | null,"feedback_ask_nps"?: boolean,"feedback_enabled"?: boolean,"feedback_include_no_show"?: boolean,"health_tagged"?: boolean,"hide_product_branding"?: boolean,"id"?: string,"legal_name"?: string | null,"logo_path"?: string | null,"name": string,"postal_address"?: string | null,"require_mfa_for_admins"?: boolean,"retention_days"?: number,"scope_staff_to_lines"?: boolean,"single_active_visit"?: Database["app"]['Enums']["single_active_scope"],"status"?: Database["app"]['Enums']["org_status"],"support_contact"?: string | null,"suspended_at"?: string | null,"suspended_by"?: string | null,"suspended_reason"?: string | null,"updated_at"?: string,"waiver_retention_days"?: number
                  }
                  Update: {
                    "brand_accent"?: string | null,"brand_primary"?: string | null,"created_at"?: string,"created_by"?: string | null,"default_locale"?: string,"deletion_requested_at"?: string | null,"deletion_scheduled_for"?: string | null,"external_purged_at"?: string | null,"feedback_ask_nps"?: boolean,"feedback_enabled"?: boolean,"feedback_include_no_show"?: boolean,"health_tagged"?: boolean,"hide_product_branding"?: boolean,"id"?: string,"legal_name"?: string | null,"logo_path"?: string | null,"name"?: string,"postal_address"?: string | null,"require_mfa_for_admins"?: boolean,"retention_days"?: number,"scope_staff_to_lines"?: boolean,"single_active_visit"?: Database["app"]['Enums']["single_active_scope"],"status"?: Database["app"]['Enums']["org_status"],"support_contact"?: string | null,"suspended_at"?: string | null,"suspended_by"?: string | null,"suspended_reason"?: string | null,"updated_at"?: string,"waiver_retention_days"?: number
                  }
                  Relationships: [
                    
                  ]
                },"pay_codes": {
                  Row: {
                    "code_hash": string,"created_at": string,"expires_at": string,"org_id": string,"payment_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "code_hash": string,"created_at"?: string,"expires_at": string,"org_id": string,"payment_id": string
                  }
                  Update: {
                    "code_hash"?: string,"created_at"?: string,"expires_at"?: string,"org_id"?: string,"payment_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "pay_codes_org_id_payment_id_fkey"
      columns: ["org_id","payment_id"]
isOneToOne: false
      referencedRelation: "payments"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"payment_events": {
                  Row: {
                    "org_id": string,"payload_minimal": NonNullable<Json>,"provider": string,"provider_event_id": string,"received_at": string,"type": string
                  }
                  ComputedFields: never
                  Insert: {
                    "org_id": string,"payload_minimal"?: NonNullable<Json>,"provider": string,"provider_event_id": string,"received_at"?: string,"type": string
                  }
                  Update: {
                    "org_id"?: string,"payload_minimal"?: NonNullable<Json>,"provider"?: string,"provider_event_id"?: string,"received_at"?: string,"type"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_events_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"payment_holds": {
                  Row: {
                    "amount_minor": number,"appointment_id": string | null,"created_at": string,"currency": string,"id": string,"idempotency_key": string,"org_id": string,"provider": string,"provider_hold_id": string,"status": Database["app"]['Enums']["payment_status"],"updated_at": string,"visit_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor": number,"appointment_id"?: string | null,"created_at"?: string,"currency": string,"id"?: string,"idempotency_key": string,"org_id": string,"provider": string,"provider_hold_id": string,"status"?: Database["app"]['Enums']["payment_status"],"updated_at"?: string,"visit_id"?: string | null
                  }
                  Update: {
                    "amount_minor"?: number,"appointment_id"?: string | null,"created_at"?: string,"currency"?: string,"id"?: string,"idempotency_key"?: string,"org_id"?: string,"provider"?: string,"provider_hold_id"?: string,"status"?: Database["app"]['Enums']["payment_status"],"updated_at"?: string,"visit_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_holds_org_id_appointment_id_fkey"
      columns: ["org_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "payment_holds_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "payment_holds_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "payment_holds_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"payment_jobs": {
                  Row: {
                    "action": string,"amount_minor": number | null,"attempts": number,"created_at": string,"dedupe_key": string,"id": string,"last_error": string | null,"location_id": string,"locked_until": string | null,"next_attempt_at": string,"org_id": string,"payment_id": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"amount_minor"?: number | null,"attempts"?: number,"created_at"?: string,"dedupe_key": string,"id"?: string,"last_error"?: string | null,"location_id": string,"locked_until"?: string | null,"next_attempt_at"?: string,"org_id": string,"payment_id": string,"status"?: string
                  }
                  Update: {
                    "action"?: string,"amount_minor"?: number | null,"attempts"?: number,"created_at"?: string,"dedupe_key"?: string,"id"?: string,"last_error"?: string | null,"location_id"?: string,"locked_until"?: string | null,"next_attempt_at"?: string,"org_id"?: string,"payment_id"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_jobs_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "payment_jobs_org_id_payment_id_fkey"
      columns: ["org_id","payment_id"]
isOneToOne: false
      referencedRelation: "payments"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"payment_policies": {
                  Row: {
                    "amount_minor": number,"cancel_cutoff_hours": number,"currency": string,"id": string,"location_id": string,"mode": string,"org_id": string,"pay_within_minutes": number,"release_after": string,"service_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor"?: number,"cancel_cutoff_hours"?: number,"currency"?: string,"id"?: string,"location_id": string,"mode"?: string,"org_id": string,"pay_within_minutes"?: number,"release_after"?: string,"service_id": string,"updated_at"?: string
                  }
                  Update: {
                    "amount_minor"?: number,"cancel_cutoff_hours"?: number,"currency"?: string,"id"?: string,"location_id"?: string,"mode"?: string,"org_id"?: string,"pay_within_minutes"?: number,"release_after"?: string,"service_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "payment_policies_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "payment_policies_org_id_service_id_fkey"
      columns: ["org_id","service_id"]
isOneToOne: true
      referencedRelation: "services"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"payments": {
                  Row: {
                    "amount_minor": number,"appointment_id": string | null,"cancel_cutoff_hours": number,"created_at": string,"currency": string,"customer_id": string | null,"id": string,"idempotency_key": string,"intent_id": string | null,"kind": string,"location_id": string,"org_id": string,"payment_method_id": string | null,"provider": string,"refunded_minor": number,"release_after": string,"setup_intent_id": string | null,"status": string,"updated_at": string,"visit_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_minor": number,"appointment_id"?: string | null,"cancel_cutoff_hours"?: number,"created_at"?: string,"currency": string,"customer_id"?: string | null,"id"?: string,"idempotency_key": string,"intent_id"?: string | null,"kind": string,"location_id": string,"org_id": string,"payment_method_id"?: string | null,"provider": string,"refunded_minor"?: number,"release_after"?: string,"setup_intent_id"?: string | null,"status"?: string,"updated_at"?: string,"visit_id"?: string | null
                  }
                  Update: {
                    "amount_minor"?: number,"appointment_id"?: string | null,"cancel_cutoff_hours"?: number,"created_at"?: string,"currency"?: string,"customer_id"?: string | null,"id"?: string,"idempotency_key"?: string,"intent_id"?: string | null,"kind"?: string,"location_id"?: string,"org_id"?: string,"payment_method_id"?: string | null,"provider"?: string,"refunded_minor"?: number,"release_after"?: string,"setup_intent_id"?: string | null,"status"?: string,"updated_at"?: string,"visit_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "payments_org_id_appointment_id_fkey"
      columns: ["org_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "payments_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "payments_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "payments_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"plan_entitlements": {
                  Row: {
                    "key": string,"plan_id": string,"value": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "key": string,"plan_id": string,"value": NonNullable<Json>
                  }
                  Update: {
                    "key"?: string,"plan_id"?: string,"value"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "plan_entitlements_key_fkey"
      columns: ["key"]
isOneToOne: false
      referencedRelation: "entitlement_defaults"
      referencedColumns: ["key"]
    },{
      foreignKeyName: "plan_entitlements_plan_id_fkey"
      columns: ["plan_id"]
isOneToOne: false
      referencedRelation: "plans"
      referencedColumns: ["id"]
    }
                  ]
                },"plans": {
                  Row: {
                    "currency": string,"id": string,"name": string,"stripe_price_id": string | null,"stripe_price_id_annual": string | null,"unit_price_annual_minor": number | null,"unit_price_minor": number
                  }
                  ComputedFields: never
                  Insert: {
                    "currency"?: string,"id": string,"name": string,"stripe_price_id"?: string | null,"stripe_price_id_annual"?: string | null,"unit_price_annual_minor"?: number | null,"unit_price_minor"?: number
                  }
                  Update: {
                    "currency"?: string,"id"?: string,"name"?: string,"stripe_price_id"?: string | null,"stripe_price_id_annual"?: string | null,"unit_price_annual_minor"?: number | null,"unit_price_minor"?: number
                  }
                  Relationships: [
                    
                  ]
                },"platform_announcements": {
                  Row: {
                    "created_at": string,"created_by": string | null,"ends_at": string,"id": string,"message": string,"severity": Database["app"]['Enums']["announcement_severity"],"starts_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"ends_at": string,"id"?: string,"message": string,"severity": Database["app"]['Enums']["announcement_severity"],"starts_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"ends_at"?: string,"id"?: string,"message"?: string,"severity"?: Database["app"]['Enums']["announcement_severity"],"starts_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"platform_attention_acks": {
                  Row: {
                    "acked_at": string,"acked_by": string | null,"org_id": string,"reason": string,"snooze_until": string
                  }
                  ComputedFields: never
                  Insert: {
                    "acked_at"?: string,"acked_by"?: string | null,"org_id": string,"reason": string,"snooze_until": string
                  }
                  Update: {
                    "acked_at"?: string,"acked_by"?: string | null,"org_id"?: string,"reason"?: string,"snooze_until"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "platform_attention_acks_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"platform_audit": {
                  Row: {
                    "action": string,"actor_id": string | null,"at": string,"id": number,"org_id": string | null,"reason": string | null,"target": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_id"?: string | null,"at"?: string,"id"?: never,"org_id"?: string | null,"reason"?: string | null,"target"?: NonNullable<Json>
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"at"?: string,"id"?: never,"org_id"?: string | null,"reason"?: string | null,"target"?: NonNullable<Json>
                  }
                  Relationships: [
                    
                  ]
                },"platform_blocks": {
                  Row: {
                    "contact_hash": string,"created_at": string,"created_by": string | null,"expires_at": string | null,"kind": Database["app"]['Enums']["contact_channel"],"reason": string
                  }
                  ComputedFields: never
                  Insert: {
                    "contact_hash": string,"created_at"?: string,"created_by"?: string | null,"expires_at"?: string | null,"kind": Database["app"]['Enums']["contact_channel"],"reason": string
                  }
                  Update: {
                    "contact_hash"?: string,"created_at"?: string,"created_by"?: string | null,"expires_at"?: string | null,"kind"?: Database["app"]['Enums']["contact_channel"],"reason"?: string
                  }
                  Relationships: [
                    
                  ]
                },"platform_daily_stats": {
                  Row: {
                    "cancelled": number,"computed_at": string,"day": string,"joins": number,"no_shows": number,"notifications_failed": number,"notifications_sent": number,"org_id": string,"served": number
                  }
                  ComputedFields: never
                  Insert: {
                    "cancelled"?: number,"computed_at"?: string,"day": string,"joins"?: number,"no_shows"?: number,"notifications_failed"?: number,"notifications_sent"?: number,"org_id": string,"served"?: number
                  }
                  Update: {
                    "cancelled"?: number,"computed_at"?: string,"day"?: string,"joins"?: number,"no_shows"?: number,"notifications_failed"?: number,"notifications_sent"?: number,"org_id"?: string,"served"?: number
                  }
                  Relationships: [
                    
                  ]
                },"platform_flags": {
                  Row: {
                    "billing_enabled": boolean,"compliance_gate_passed_at": string | null,"credit_low_micros": number,"hosted_legal_reviewed_at": string | null,"max_retention_days": number,"singleton": boolean,"sms_bundle_grant_micros": number,"sms_margin_bps": number,"support_inbox": string
                  }
                  ComputedFields: never
                  Insert: {
                    "billing_enabled"?: boolean,"compliance_gate_passed_at"?: string | null,"credit_low_micros"?: number,"hosted_legal_reviewed_at"?: string | null,"max_retention_days"?: number,"singleton"?: boolean,"sms_bundle_grant_micros"?: number,"sms_margin_bps"?: number,"support_inbox"?: string
                  }
                  Update: {
                    "billing_enabled"?: boolean,"compliance_gate_passed_at"?: string | null,"credit_low_micros"?: number,"hosted_legal_reviewed_at"?: string | null,"max_retention_days"?: number,"singleton"?: boolean,"sms_bundle_grant_micros"?: number,"sms_margin_bps"?: number,"support_inbox"?: string
                  }
                  Relationships: [
                    
                  ]
                },"platform_incident_events": {
                  Row: {
                    "actor_id": string | null,"body": string | null,"created_at": string,"id": string,"incident_id": string,"kind": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"body"?: string | null,"created_at"?: string,"id"?: string,"incident_id": string,"kind": string
                  }
                  Update: {
                    "actor_id"?: string | null,"body"?: string | null,"created_at"?: string,"id"?: string,"incident_id"?: string,"kind"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "platform_incident_events_incident_id_fkey"
      columns: ["incident_id"]
isOneToOne: false
      referencedRelation: "platform_incidents"
      referencedColumns: ["id"]
    }
                  ]
                },"platform_incidents": {
                  Row: {
                    "containment": string | null,"created_at": string,"created_by": string | null,"data_categories": (string)[],"description": string | null,"detected_at": string,"id": string,"idempotency_key": string | null,"kind": string,"lessons": string | null,"notice_waived_reason": string | null,"notified_at": string | null,"org_ids": (string)[],"record_count": number | null,"root_cause": string | null,"status": Database["app"]['Enums']["incident_status"],"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "containment"?: string | null,"created_at"?: string,"created_by"?: string | null,"data_categories"?: (string)[],"description"?: string | null,"detected_at"?: string,"id"?: string,"idempotency_key"?: string | null,"kind": string,"lessons"?: string | null,"notice_waived_reason"?: string | null,"notified_at"?: string | null,"org_ids"?: (string)[],"record_count"?: number | null,"root_cause"?: string | null,"status"?: Database["app"]['Enums']["incident_status"],"title": string,"updated_at"?: string
                  }
                  Update: {
                    "containment"?: string | null,"created_at"?: string,"created_by"?: string | null,"data_categories"?: (string)[],"description"?: string | null,"detected_at"?: string,"id"?: string,"idempotency_key"?: string | null,"kind"?: string,"lessons"?: string | null,"notice_waived_reason"?: string | null,"notified_at"?: string | null,"org_ids"?: (string)[],"record_count"?: number | null,"root_cause"?: string | null,"status"?: Database["app"]['Enums']["incident_status"],"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"platform_org_notes": {
                  Row: {
                    "author_id": string | null,"body": string,"created_at": string,"id": string,"idempotency_key": string | null,"org_id": string,"root_id": string,"tags": (string)[],"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "author_id"?: string | null,"body": string,"created_at"?: string,"id"?: string,"idempotency_key"?: string | null,"org_id": string,"root_id": string,"tags"?: (string)[],"version": number
                  }
                  Update: {
                    "author_id"?: string | null,"body"?: string,"created_at"?: string,"id"?: string,"idempotency_key"?: string | null,"org_id"?: string,"root_id"?: string,"tags"?: (string)[],"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "platform_org_notes_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"platform_roles": {
                  Row: {
                    "granted_at": string,"granted_by": string | null,"role": Database["app"]['Enums']["platform_role"],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "granted_at"?: string,"granted_by"?: string | null,"role": Database["app"]['Enums']["platform_role"],"user_id": string
                  }
                  Update: {
                    "granted_at"?: string,"granted_by"?: string | null,"role"?: Database["app"]['Enums']["platform_role"],"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"platform_sms_daily": {
                  Row: {
                    "billed_micros": number,"computed_at": string,"cost_micros": number,"country": string,"day": string,"delivered": number,"failed": number,"filtered": number,"helps": number,"locale": string,"messages": number,"optins": number,"org_id": string,"otp_sent": number,"otp_verified": number,"segments": number,"stops": number,"suppressed": number,"template_key": string,"undelivered": number
                  }
                  ComputedFields: never
                  Insert: {
                    "billed_micros"?: number,"computed_at"?: string,"cost_micros"?: number,"country"?: string,"day": string,"delivered"?: number,"failed"?: number,"filtered"?: number,"helps"?: number,"locale"?: string,"messages"?: number,"optins"?: number,"org_id": string,"otp_sent"?: number,"otp_verified"?: number,"segments"?: number,"stops"?: number,"suppressed"?: number,"template_key"?: string,"undelivered"?: number
                  }
                  Update: {
                    "billed_micros"?: number,"computed_at"?: string,"cost_micros"?: number,"country"?: string,"day"?: string,"delivered"?: number,"failed"?: number,"filtered"?: number,"helps"?: number,"locale"?: string,"messages"?: number,"optins"?: number,"org_id"?: string,"otp_sent"?: number,"otp_verified"?: number,"segments"?: number,"stops"?: number,"suppressed"?: number,"template_key"?: string,"undelivered"?: number
                  }
                  Relationships: [
                    
                  ]
                },"priority_classes": {
                  Row: {
                    "active": boolean,"color": string | null,"created_at": string,"id": string,"location_id": string,"name": string,"offset_minutes": number,"org_id": string,"sort_order": number
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"color"?: string | null,"created_at"?: string,"id"?: string,"location_id": string,"name": string,"offset_minutes": number,"org_id": string,"sort_order"?: number
                  }
                  Update: {
                    "active"?: boolean,"color"?: string | null,"created_at"?: string,"id"?: string,"location_id"?: string,"name"?: string,"offset_minutes"?: number,"org_id"?: string,"sort_order"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "priority_classes_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"priority_rules": {
                  Row: {
                    "active": boolean,"answer_value": string | null,"condition_kind": Database["app"]['Enums']["priority_condition"],"created_at": string,"field_id": string | null,"id": string,"location_id": string,"org_id": string,"priority_class_id": string,"queue_id": string | null,"rank": number,"source": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"answer_value"?: string | null,"condition_kind": Database["app"]['Enums']["priority_condition"],"created_at"?: string,"field_id"?: string | null,"id"?: string,"location_id": string,"org_id": string,"priority_class_id": string,"queue_id"?: string | null,"rank"?: number,"source"?: string | null
                  }
                  Update: {
                    "active"?: boolean,"answer_value"?: string | null,"condition_kind"?: Database["app"]['Enums']["priority_condition"],"created_at"?: string,"field_id"?: string | null,"id"?: string,"location_id"?: string,"org_id"?: string,"priority_class_id"?: string,"queue_id"?: string | null,"rank"?: number,"source"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "priority_rules_org_id_field_id_fkey"
      columns: ["org_id","field_id"]
isOneToOne: false
      referencedRelation: "intake_fields"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "priority_rules_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "priority_rules_org_id_location_id_priority_class_id_fkey"
      columns: ["org_id","location_id","priority_class_id"]
isOneToOne: false
      referencedRelation: "priority_classes"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "priority_rules_org_id_location_id_queue_id_fkey"
      columns: ["org_id","location_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"provider_rates": {
                  Row: {
                    "channel": Database["app"]['Enums']["notification_channel"],"country_code": string | null,"created_at": string,"currency": string,"id": string,"micros_per_unit": number,"note": string | null,"org_id": string | null,"provider": string,"valid_from": string
                  }
                  ComputedFields: never
                  Insert: {
                    "channel": Database["app"]['Enums']["notification_channel"],"country_code"?: string | null,"created_at"?: string,"currency"?: string,"id"?: string,"micros_per_unit": number,"note"?: string | null,"org_id"?: string | null,"provider": string,"valid_from"?: string
                  }
                  Update: {
                    "channel"?: Database["app"]['Enums']["notification_channel"],"country_code"?: string | null,"created_at"?: string,"currency"?: string,"id"?: string,"micros_per_unit"?: number,"note"?: string | null,"org_id"?: string | null,"provider"?: string,"valid_from"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "provider_rates_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"provider_settings": {
                  Row: {
                    "channel": string,"config": NonNullable<Json>,"enabled": boolean,"endpoint_id": string,"id": string,"messaging_campaign_ref": string | null,"mode": string,"org_id": string,"provider": string,"secret_hints": NonNullable<Json>,"secret_ids": NonNullable<Json>,"updated_at": string,"verified_at": string | null,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "channel": string,"config"?: NonNullable<Json>,"enabled"?: boolean,"endpoint_id"?: string,"id"?: string,"messaging_campaign_ref"?: string | null,"mode": string,"org_id": string,"provider": string,"secret_hints"?: NonNullable<Json>,"secret_ids"?: NonNullable<Json>,"updated_at"?: string,"verified_at"?: string | null,"version"?: number
                  }
                  Update: {
                    "channel"?: string,"config"?: NonNullable<Json>,"enabled"?: boolean,"endpoint_id"?: string,"id"?: string,"messaging_campaign_ref"?: string | null,"mode"?: string,"org_id"?: string,"provider"?: string,"secret_hints"?: NonNullable<Json>,"secret_ids"?: NonNullable<Json>,"updated_at"?: string,"verified_at"?: string | null,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "provider_settings_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"push_subscriptions": {
                  Row: {
                    "appointment_id": string | null,"auth": string,"created_at": string,"endpoint": string,"id": string,"org_id": string,"p256dh": string,"visit_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "appointment_id"?: string | null,"auth": string,"created_at"?: string,"endpoint": string,"id"?: string,"org_id": string,"p256dh": string,"visit_id"?: string | null
                  }
                  Update: {
                    "appointment_id"?: string | null,"auth"?: string,"created_at"?: string,"endpoint"?: string,"id"?: string,"org_id"?: string,"p256dh"?: string,"visit_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "push_subscriptions_appointment_fk"
      columns: ["org_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "push_subscriptions_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "push_subscriptions_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"queue_broadcasts": {
                  Row: {
                    "body": string,"created_at": string,"id": string,"org_id": string,"queue_id": string,"recipients": number,"sent_by": string | null,"suppressed": number
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"created_at"?: string,"id"?: string,"org_id": string,"queue_id": string,"recipients"?: number,"sent_by"?: string | null,"suppressed"?: number
                  }
                  Update: {
                    "body"?: string,"created_at"?: string,"id"?: string,"org_id"?: string,"queue_id"?: string,"recipients"?: number,"sent_by"?: string | null,"suppressed"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "queue_broadcasts_org_id_queue_id_fkey"
      columns: ["org_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"queues": {
                  Row: {
                    "almost_up_threshold": number,"archived_at": string | null,"assignment_strategy": Database["app"]['Enums']["assignment_strategy"],"auto_no_show_enabled": boolean,"brand_accent": string | null,"capacity": number | null,"channel_order": (string)[],"chat_enabled": boolean,"created_at": string,"early_checkin_minutes": number,"eta_reserves_appointments": boolean,"grace_minutes": number,"id": string,"join_later_enabled": boolean,"join_later_max_hours": number,"join_rate_per_min": number,"join_restriction": Database["app"]['Enums']["join_restriction"],"kind": string,"late_tolerance_minutes": number,"location_id": string,"manual_state": Database["api"]['Enums']["queue_state"],"max_active_per_contact": number,"max_snoozes": number,"max_walkin_delay_minutes": number,"name": string,"no_show_after_minutes": number,"no_show_warning_seconds": number,"notify_triggers": (string)[],"online_joins_per_hour": number,"org_id": string,"origin_template": string | null,"origin_version": number | null,"party_size_enabled": boolean,"party_size_max": number,"party_size_min": number,"pulls_from": string | null,"pulse_id": string,"renotify_eta_delta_minutes": number,"renotify_min_interval_seconds": number,"renotify_position_delta": number,"rr_cursor": string | null,"servers_on_duty": number,"serving_reminder_minutes": number | null,"show_eta": boolean,"sms_keyword": string | null,"snooze_places": number,"sort_order": number,"ticket_prefix": string,"updated_at": string,"use_shift_schedule": boolean,"version": number,"wait_override_minutes": number | null,"wait_override_until": string | null,"welcome_text": string | null,"online_joins_paused_until": string | null
                  }
                  ComputedFields: "online_joins_paused_until"
                  Insert: {
                    "almost_up_threshold"?: number,"archived_at"?: string | null,"assignment_strategy"?: Database["app"]['Enums']["assignment_strategy"],"auto_no_show_enabled"?: boolean,"brand_accent"?: string | null,"capacity"?: number | null,"channel_order"?: (string)[],"chat_enabled"?: boolean,"created_at"?: string,"early_checkin_minutes"?: number,"eta_reserves_appointments"?: boolean,"grace_minutes"?: number,"id"?: string,"join_later_enabled"?: boolean,"join_later_max_hours"?: number,"join_rate_per_min"?: number,"join_restriction"?: Database["app"]['Enums']["join_restriction"],"kind"?: string,"late_tolerance_minutes"?: number,"location_id": string,"manual_state"?: Database["api"]['Enums']["queue_state"],"max_active_per_contact"?: number,"max_snoozes"?: number,"max_walkin_delay_minutes"?: number,"name": string,"no_show_after_minutes"?: number,"no_show_warning_seconds"?: number,"notify_triggers"?: (string)[],"online_joins_per_hour"?: number,"org_id": string,"origin_template"?: string | null,"origin_version"?: number | null,"party_size_enabled"?: boolean,"party_size_max"?: number,"party_size_min"?: number,"pulls_from"?: string | null,"pulse_id"?: string,"renotify_eta_delta_minutes"?: number,"renotify_min_interval_seconds"?: number,"renotify_position_delta"?: number,"rr_cursor"?: string | null,"servers_on_duty"?: number,"serving_reminder_minutes"?: number | null,"show_eta"?: boolean,"sms_keyword"?: string | null,"snooze_places"?: number,"sort_order"?: number,"ticket_prefix"?: string,"updated_at"?: string,"use_shift_schedule"?: boolean,"version"?: number,"wait_override_minutes"?: number | null,"wait_override_until"?: string | null,"welcome_text"?: string | null
                  }
                  Update: {
                    "almost_up_threshold"?: number,"archived_at"?: string | null,"assignment_strategy"?: Database["app"]['Enums']["assignment_strategy"],"auto_no_show_enabled"?: boolean,"brand_accent"?: string | null,"capacity"?: number | null,"channel_order"?: (string)[],"chat_enabled"?: boolean,"created_at"?: string,"early_checkin_minutes"?: number,"eta_reserves_appointments"?: boolean,"grace_minutes"?: number,"id"?: string,"join_later_enabled"?: boolean,"join_later_max_hours"?: number,"join_rate_per_min"?: number,"join_restriction"?: Database["app"]['Enums']["join_restriction"],"kind"?: string,"late_tolerance_minutes"?: number,"location_id"?: string,"manual_state"?: Database["api"]['Enums']["queue_state"],"max_active_per_contact"?: number,"max_snoozes"?: number,"max_walkin_delay_minutes"?: number,"name"?: string,"no_show_after_minutes"?: number,"no_show_warning_seconds"?: number,"notify_triggers"?: (string)[],"online_joins_per_hour"?: number,"org_id"?: string,"origin_template"?: string | null,"origin_version"?: number | null,"party_size_enabled"?: boolean,"party_size_max"?: number,"party_size_min"?: number,"pulls_from"?: string | null,"pulse_id"?: string,"renotify_eta_delta_minutes"?: number,"renotify_min_interval_seconds"?: number,"renotify_position_delta"?: number,"rr_cursor"?: string | null,"servers_on_duty"?: number,"serving_reminder_minutes"?: number | null,"show_eta"?: boolean,"sms_keyword"?: string | null,"snooze_places"?: number,"sort_order"?: number,"ticket_prefix"?: string,"updated_at"?: string,"use_shift_schedule"?: boolean,"version"?: number,"wait_override_minutes"?: number | null,"wait_override_until"?: string | null,"welcome_text"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "queues_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "queues_pulls_from_fk"
      columns: ["org_id","location_id","pulls_from"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"report_definitions": {
                  Row: {
                    "created_at": string,"created_by": string | null,"definition": NonNullable<Json>,"id": string,"name": string,"org_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"definition": NonNullable<Json>,"id"?: string,"name": string,"org_id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"definition"?: NonNullable<Json>,"id"?: string,"name"?: string,"org_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "report_definitions_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"report_schedules": {
                  Row: {
                    "created_at": string,"enabled": boolean,"frequency": string,"id": string,"location_id": string,"org_id": string,"recipients": (string)[],"send_at_local": string,"updated_at": string,"weekday": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"enabled"?: boolean,"frequency": string,"id"?: string,"location_id": string,"org_id": string,"recipients"?: (string)[],"send_at_local": string,"updated_at"?: string,"weekday"?: number | null
                  }
                  Update: {
                    "created_at"?: string,"enabled"?: boolean,"frequency"?: string,"id"?: string,"location_id"?: string,"org_id"?: string,"recipients"?: (string)[],"send_at_local"?: string,"updated_at"?: string,"weekday"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "report_schedules_location_id_fkey"
      columns: ["location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "report_schedules_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"retention_runs": {
                  Row: {
                    "appointments_anonymized": number,"contacts_deleted": number,"id": number,"org_id": string,"ran_at": string,"visits_anonymized": number
                  }
                  ComputedFields: never
                  Insert: {
                    "appointments_anonymized": number,"contacts_deleted": number,"id"?: never,"org_id": string,"ran_at"?: string,"visits_anonymized": number
                  }
                  Update: {
                    "appointments_anonymized"?: number,"contacts_deleted"?: number,"id"?: never,"org_id"?: string,"ran_at"?: string,"visits_anonymized"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "retention_runs_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"routing_rules": {
                  Row: {
                    "active": boolean,"answer_value": string | null,"created_at": string,"field_id": string | null,"id": string,"location_id": string,"org_id": string,"rank": number,"service_id": string | null,"target_queue_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"answer_value"?: string | null,"created_at"?: string,"field_id"?: string | null,"id"?: string,"location_id": string,"org_id": string,"rank"?: number,"service_id"?: string | null,"target_queue_id": string
                  }
                  Update: {
                    "active"?: boolean,"answer_value"?: string | null,"created_at"?: string,"field_id"?: string | null,"id"?: string,"location_id"?: string,"org_id"?: string,"rank"?: number,"service_id"?: string | null,"target_queue_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "routing_rules_org_id_field_id_fkey"
      columns: ["org_id","field_id"]
isOneToOne: false
      referencedRelation: "intake_fields"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "routing_rules_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "routing_rules_org_id_location_id_service_id_fkey"
      columns: ["org_id","location_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "routing_rules_org_id_location_id_target_queue_id_fkey"
      columns: ["org_id","location_id","target_queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"service_resources": {
                  Row: {
                    "counter_id": string,"created_at": string,"location_id": string,"org_id": string,"service_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "counter_id": string,"created_at"?: string,"location_id": string,"org_id": string,"service_id": string
                  }
                  Update: {
                    "counter_id"?: string,"created_at"?: string,"location_id"?: string,"org_id"?: string,"service_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "service_resources_org_id_location_id_counter_id_fkey"
      columns: ["org_id","location_id","counter_id"]
isOneToOne: false
      referencedRelation: "counters"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "service_resources_org_id_location_id_service_id_fkey"
      columns: ["org_id","location_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"services": {
                  Row: {
                    "active": boolean,"color": string | null,"created_at": string,"description": string | null,"expected_minutes": number,"id": string,"journey_id": string | null,"location_id": string,"name": string,"org_id": string,"queue_id": string,"sort_order": number,"ticket_prefix": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"color"?: string | null,"created_at"?: string,"description"?: string | null,"expected_minutes"?: number,"id"?: string,"journey_id"?: string | null,"location_id": string,"name": string,"org_id": string,"queue_id": string,"sort_order"?: number,"ticket_prefix"?: string | null
                  }
                  Update: {
                    "active"?: boolean,"color"?: string | null,"created_at"?: string,"description"?: string | null,"expected_minutes"?: number,"id"?: string,"journey_id"?: string | null,"location_id"?: string,"name"?: string,"org_id"?: string,"queue_id"?: string,"sort_order"?: number,"ticket_prefix"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "services_journey_id_fkey"
      columns: ["journey_id"]
isOneToOne: false
      referencedRelation: "journeys"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "services_org_id_location_id_queue_id_fkey"
      columns: ["org_id","location_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"signage_slides": {
                  Row: {
                    "active_from": string | null,"active_to": string | null,"body": string | null,"created_at": string,"duration_s": number,"id": string,"kind": Database["app"]['Enums']["signage_kind"],"location_id": string,"org_id": string,"sort": number,"storage_path": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active_from"?: string | null,"active_to"?: string | null,"body"?: string | null,"created_at"?: string,"duration_s"?: number,"id"?: string,"kind": Database["app"]['Enums']["signage_kind"],"location_id": string,"org_id": string,"sort"?: number,"storage_path"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "active_from"?: string | null,"active_to"?: string | null,"body"?: string | null,"created_at"?: string,"duration_s"?: number,"id"?: string,"kind"?: Database["app"]['Enums']["signage_kind"],"location_id"?: string,"org_id"?: string,"sort"?: number,"storage_path"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "signage_slides_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"slot_waitlist": {
                  Row: {
                    "appointment_id": string | null,"contact_id": string | null,"created_at": string,"during": unknown,"guest_email": string | null,"guest_phone_e164": string | null,"id": string,"idempotency_key": string,"location_id": string,"name": string,"offer_expires_at": string | null,"offered_slot": unknown,"org_id": string,"service_id": string,"status": Database["app"]['Enums']["waitlist_status"],"token_hash": string,"wanted_day": string
                  }
                  ComputedFields: never
                  Insert: {
                    "appointment_id"?: string | null,"contact_id"?: string | null,"created_at"?: string,"during"?: unknown,"guest_email"?: string | null,"guest_phone_e164"?: string | null,"id"?: string,"idempotency_key": string,"location_id": string,"name": string,"offer_expires_at"?: string | null,"offered_slot"?: unknown,"org_id": string,"service_id": string,"status"?: Database["app"]['Enums']["waitlist_status"],"token_hash": string,"wanted_day": string
                  }
                  Update: {
                    "appointment_id"?: string | null,"contact_id"?: string | null,"created_at"?: string,"during"?: unknown,"guest_email"?: string | null,"guest_phone_e164"?: string | null,"id"?: string,"idempotency_key"?: string,"location_id"?: string,"name"?: string,"offer_expires_at"?: string | null,"offered_slot"?: unknown,"org_id"?: string,"service_id"?: string,"status"?: Database["app"]['Enums']["waitlist_status"],"token_hash"?: string,"wanted_day"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "slot_waitlist_org_id_appointment_id_fkey"
      columns: ["org_id","appointment_id"]
isOneToOne: false
      referencedRelation: "appointments"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "slot_waitlist_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "slot_waitlist_org_id_service_id_fkey"
      columns: ["org_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"slug_redirects": {
                  Row: {
                    "created_at": string,"location_id": string,"old_slug": string,"org_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"location_id": string,"old_slug": string,"org_id": string
                  }
                  Update: {
                    "created_at"?: string,"location_id"?: string,"old_slug"?: string,"org_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "slug_redirects_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"sms_footers": {
                  Row: {
                    "locale": string,"text": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "locale": string,"text": string,"version": number
                  }
                  Update: {
                    "locale"?: string,"text"?: string,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"sms_guard_terms": {
                  Row: {
                    "reason": string,"term": string
                  }
                  ComputedFields: never
                  Insert: {
                    "reason": string,"term": string
                  }
                  Update: {
                    "reason"?: string,"term"?: string
                  }
                  Relationships: [
                    
                  ]
                },"staff_presence": {
                  Row: {
                    "counter_id": string | null,"location_id": string,"org_id": string,"since": string,"status": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "counter_id"?: string | null,"location_id": string,"org_id": string,"since"?: string,"status": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "counter_id"?: string | null,"location_id"?: string,"org_id"?: string,"since"?: string,"status"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "staff_presence_org_id_location_id_counter_id_fkey"
      columns: ["org_id","location_id","counter_id"]
isOneToOne: false
      referencedRelation: "counters"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "staff_presence_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "staff_presence_org_id_user_id_fkey"
      columns: ["org_id","user_id"]
isOneToOne: false
      referencedRelation: "memberships"
      referencedColumns: ["org_id","user_id"]
    }
                  ]
                },"staff_shifts": {
                  Row: {
                    "counter_id": string | null,"created_at": string,"during": unknown,"id": string,"location_id": string,"note": string | null,"org_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "counter_id"?: string | null,"created_at"?: string,"during": unknown,"id"?: string,"location_id": string,"note"?: string | null,"org_id": string,"user_id": string
                  }
                  Update: {
                    "counter_id"?: string | null,"created_at"?: string,"during"?: unknown,"id"?: string,"location_id"?: string,"note"?: string | null,"org_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "staff_shifts_org_id_location_id_counter_id_fkey"
      columns: ["org_id","location_id","counter_id"]
isOneToOne: false
      referencedRelation: "counters"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "staff_shifts_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "staff_shifts_org_id_user_id_fkey"
      columns: ["org_id","user_id"]
isOneToOne: false
      referencedRelation: "memberships"
      referencedColumns: ["org_id","user_id"]
    }
                  ]
                },"subscriptions": {
                  Row: {
                    "billing_interval": string,"current_period_end": string | null,"desired_quantity": number,"grace_ends_at": string | null,"last_event_at": string | null,"org_id": string,"plan_id": string,"quantity": number,"status": string,"stripe_customer_id": string | null,"stripe_subscription_id": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "billing_interval"?: string,"current_period_end"?: string | null,"desired_quantity"?: number,"grace_ends_at"?: string | null,"last_event_at"?: string | null,"org_id": string,"plan_id"?: string,"quantity"?: number,"status"?: string,"stripe_customer_id"?: string | null,"stripe_subscription_id"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "billing_interval"?: string,"current_period_end"?: string | null,"desired_quantity"?: number,"grace_ends_at"?: string | null,"last_event_at"?: string | null,"org_id"?: string,"plan_id"?: string,"quantity"?: number,"status"?: string,"stripe_customer_id"?: string | null,"stripe_subscription_id"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "subscriptions_org_id_fkey"
      columns: ["org_id"]
isOneToOne: true
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "subscriptions_plan_id_fkey"
      columns: ["plan_id"]
isOneToOne: false
      referencedRelation: "plans"
      referencedColumns: ["id"]
    }
                  ]
                },"support_grants": {
                  Row: {
                    "break_glass": boolean,"created_at": string,"expires_at": string,"granted_by": string | null,"grantee": string | null,"id": string,"org_id": string,"reason": string,"revoked_at": string | null,"revoked_by": string | null,"scope": Database["app"]['Enums']["support_scope"]
                  }
                  ComputedFields: never
                  Insert: {
                    "break_glass"?: boolean,"created_at"?: string,"expires_at": string,"granted_by"?: string | null,"grantee"?: string | null,"id"?: string,"org_id": string,"reason": string,"revoked_at"?: string | null,"revoked_by"?: string | null,"scope": Database["app"]['Enums']["support_scope"]
                  }
                  Update: {
                    "break_glass"?: boolean,"created_at"?: string,"expires_at"?: string,"granted_by"?: string | null,"grantee"?: string | null,"id"?: string,"org_id"?: string,"reason"?: string,"revoked_at"?: string | null,"revoked_by"?: string | null,"scope"?: Database["app"]['Enums']["support_scope"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "support_grants_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"support_requests": {
                  Row: {
                    "closed_at": string | null,"closed_by": string | null,"context": NonNullable<Json>,"created_at": string,"id": string,"message": string,"number": number,"org_id": string,"status": string,"subject": string,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "closed_at"?: string | null,"closed_by"?: string | null,"context"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"message": string,"number"?: never,"org_id": string,"status"?: string,"subject": string,"user_id"?: string | null
                  }
                  Update: {
                    "closed_at"?: string | null,"closed_by"?: string | null,"context"?: NonNullable<Json>,"created_at"?: string,"id"?: string,"message"?: string,"number"?: never,"org_id"?: string,"status"?: string,"subject"?: string,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "support_requests_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"suppressions": {
                  Row: {
                    "channel": Database["app"]['Enums']["notification_channel"],"created_at": string,"id": string,"org_id": string,"reason": string,"value": string
                  }
                  ComputedFields: never
                  Insert: {
                    "channel": Database["app"]['Enums']["notification_channel"],"created_at"?: string,"id"?: string,"org_id": string,"reason": string,"value": string
                  }
                  Update: {
                    "channel"?: Database["app"]['Enums']["notification_channel"],"created_at"?: string,"id"?: string,"org_id"?: string,"reason"?: string,"value"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "suppressions_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"template_catalog": {
                  Row: {
                    "health_tagged": boolean,"key": string,"mode": string,"payload": NonNullable<Json>,"published_at": string,"tier": number,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "health_tagged"?: boolean,"key": string,"mode": string,"payload": NonNullable<Json>,"published_at"?: string,"tier": number,"version": number
                  }
                  Update: {
                    "health_tagged"?: boolean,"key"?: string,"mode"?: string,"payload"?: NonNullable<Json>,"published_at"?: string,"tier"?: number,"version"?: number
                  }
                  Relationships: [
                    
                  ]
                },"ticket_counters": {
                  Row: {
                    "last_value": number,"org_id": string,"prefix": string,"queue_id": string,"service_day": string
                  }
                  ComputedFields: never
                  Insert: {
                    "last_value": number,"org_id": string,"prefix": string,"queue_id": string,"service_day": string
                  }
                  Update: {
                    "last_value"?: number,"org_id"?: string,"prefix"?: string,"queue_id"?: string,"service_day"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ticket_counters_org_id_queue_id_fkey"
      columns: ["org_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"time_blocks": {
                  Row: {
                    "counter_id": string,"created_at": string,"created_by": string | null,"during": unknown,"id": string,"location_id": string,"org_id": string,"reason": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "counter_id": string,"created_at"?: string,"created_by"?: string | null,"during": unknown,"id"?: string,"location_id": string,"org_id": string,"reason"?: string | null
                  }
                  Update: {
                    "counter_id"?: string,"created_at"?: string,"created_by"?: string | null,"during"?: unknown,"id"?: string,"location_id"?: string,"org_id"?: string,"reason"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "time_blocks_org_id_location_id_counter_id_fkey"
      columns: ["org_id","location_id","counter_id"]
isOneToOne: false
      referencedRelation: "counters"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"usage_alerts": {
                  Row: {
                    "channel": Database["app"]['Enums']["notification_channel"],"created_at": string,"day": string,"org_id": string,"threshold": number
                  }
                  ComputedFields: never
                  Insert: {
                    "channel": Database["app"]['Enums']["notification_channel"],"created_at"?: string,"day": string,"org_id": string,"threshold": number
                  }
                  Update: {
                    "channel"?: Database["app"]['Enums']["notification_channel"],"created_at"?: string,"day"?: string,"org_id"?: string,"threshold"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "usage_alerts_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"usage_counters": {
                  Row: {
                    "channel": Database["app"]['Enums']["notification_channel"],"day": string,"org_id": string,"sent": number
                  }
                  ComputedFields: never
                  Insert: {
                    "channel": Database["app"]['Enums']["notification_channel"],"day": string,"org_id": string,"sent"?: number
                  }
                  Update: {
                    "channel"?: Database["app"]['Enums']["notification_channel"],"day"?: string,"org_id"?: string,"sent"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "usage_counters_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"visit_answers": {
                  Row: {
                    "answers": NonNullable<Json>,"location_id": string,"org_id": string,"updated_at": string,"visit_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "answers"?: NonNullable<Json>,"location_id": string,"org_id": string,"updated_at"?: string,"visit_id": string
                  }
                  Update: {
                    "answers"?: NonNullable<Json>,"location_id"?: string,"org_id"?: string,"updated_at"?: string,"visit_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "visit_answers_org_id_location_id_visit_id_fkey"
      columns: ["org_id","location_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "visit_answers_org_id_location_id_visit_id_fkey"
      columns: ["org_id","location_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","location_id","id"]
    }
                  ]
                },"visit_companions": {
                  Row: {
                    "created_at": string,"first_name": string,"id": string,"idempotency_key": string | null,"org_id": string,"visit_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"first_name": string,"id"?: string,"idempotency_key"?: string | null,"org_id": string,"visit_id": string
                  }
                  Update: {
                    "created_at"?: string,"first_name"?: string,"id"?: string,"idempotency_key"?: string | null,"org_id"?: string,"visit_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "visit_companions_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visit_companions_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"visit_events": {
                  Row: {
                    "actor_id": string | null,"actor_kind": Database["app"]['Enums']["actor_kind"],"from_status": Database["api"]['Enums']["visit_state"] | null,"id": number,"occurred_at": string,"org_id": string,"payload": NonNullable<Json>,"reason": string | null,"to_status": Database["api"]['Enums']["visit_state"],"type": string,"undone_by_event_id": number | null,"visit_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_id"?: string | null,"actor_kind": Database["app"]['Enums']["actor_kind"],"from_status"?: Database["api"]['Enums']["visit_state"] | null,"id"?: never,"occurred_at"?: string,"org_id": string,"payload"?: NonNullable<Json>,"reason"?: string | null,"to_status": Database["api"]['Enums']["visit_state"],"type": string,"undone_by_event_id"?: number | null,"visit_id": string
                  }
                  Update: {
                    "actor_id"?: string | null,"actor_kind"?: Database["app"]['Enums']["actor_kind"],"from_status"?: Database["api"]['Enums']["visit_state"] | null,"id"?: never,"occurred_at"?: string,"org_id"?: string,"payload"?: NonNullable<Json>,"reason"?: string | null,"to_status"?: Database["api"]['Enums']["visit_state"],"type"?: string,"undone_by_event_id"?: number | null,"visit_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "visit_events_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visit_events_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visit_events_undone_by_event_id_fkey"
      columns: ["undone_by_event_id"]
isOneToOne: false
      referencedRelation: "visit_events"
      referencedColumns: ["id"]
    }
                  ]
                },"visit_feedback": {
                  Row: {
                    "comment": string | null,"created_at": string,"id": string,"location_id": string,"nps": number | null,"org_id": string,"rating": number,"visit_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "comment"?: string | null,"created_at"?: string,"id"?: string,"location_id": string,"nps"?: number | null,"org_id": string,"rating": number,"visit_id": string
                  }
                  Update: {
                    "comment"?: string | null,"created_at"?: string,"id"?: string,"location_id"?: string,"nps"?: number | null,"org_id"?: string,"rating"?: number,"visit_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "visit_feedback_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visit_feedback_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visit_feedback_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"visit_messages": {
                  Row: {
                    "body": string,"created_at": string,"id": number,"idempotency_key": string | null,"location_id": string,"org_id": string,"read_at": string | null,"sender": string,"staff_user_id": string | null,"visit_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"created_at"?: string,"id"?: never,"idempotency_key"?: string | null,"location_id": string,"org_id": string,"read_at"?: string | null,"sender": string,"staff_user_id"?: string | null,"visit_id": string
                  }
                  Update: {
                    "body"?: string,"created_at"?: string,"id"?: never,"idempotency_key"?: string | null,"location_id"?: string,"org_id"?: string,"read_at"?: string | null,"sender"?: string,"staff_user_id"?: string | null,"visit_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "visit_messages_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visit_messages_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visit_messages_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"visit_notify_state": {
                  Row: {
                    "last_eta_high": number | null,"last_eta_low": number | null,"last_notified_at": string | null,"last_position": number | null,"org_id": string,"visit_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "last_eta_high"?: number | null,"last_eta_low"?: number | null,"last_notified_at"?: string | null,"last_position"?: number | null,"org_id": string,"visit_id": string
                  }
                  Update: {
                    "last_eta_high"?: number | null,"last_eta_low"?: number | null,"last_notified_at"?: string | null,"last_position"?: number | null,"org_id"?: string,"visit_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "visit_notify_state_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "staff_visits"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visit_notify_state_org_id_visit_id_fkey"
      columns: ["org_id","visit_id"]
isOneToOne: false
      referencedRelation: "visits"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"visit_transitions": {
                  Row: {
                    "action": Database["api"]['Enums']["visit_action"],"from_status": Database["api"]['Enums']["visit_state"],"to_status": Database["api"]['Enums']["visit_state"]
                  }
                  ComputedFields: never
                  Insert: {
                    "action": Database["api"]['Enums']["visit_action"],"from_status": Database["api"]['Enums']["visit_state"],"to_status": Database["api"]['Enums']["visit_state"]
                  }
                  Update: {
                    "action"?: Database["api"]['Enums']["visit_action"],"from_status"?: Database["api"]['Enums']["visit_state"],"to_status"?: Database["api"]['Enums']["visit_state"]
                  }
                  Relationships: [
                    
                  ]
                },"visits": {
                  Row: {
                    "anonymized_at": string | null,"arrive_after": string | null,"assigned_counter_id": string | null,"assigned_staff_id": string | null,"attribution": string | null,"call_count": number,"called_at": string | null,"contact_id": string | null,"counter_id": string | null,"device_key_hash": string | null,"device_ref_hash": string | null,"display_ticket": string,"eta_quoted_high": number | null,"eta_quoted_low": number | null,"finished_at": string | null,"grace_until": string | null,"group_key": string | null,"guest_email": string | null,"guest_id": string | null,"guest_name": string | null,"guest_phone_e164": string | null,"guest_token_hash": string,"id": string,"idempotency_key": string,"joined_at": string,"journey_id": string | null,"locale": string,"location_id": string,"manually_ordered": boolean,"notes": string | null,"org_id": string,"party_size": number,"priority_class_id": string | null,"queue_id": string,"scan_code": string | null,"scheduled_at": string | null,"service_day": string,"service_id": string | null,"serving_at": string | null,"snooze_count": number,"sort_key": number,"source": string,"status": Database["api"]['Enums']["visit_state"],"tags": (string)[],"ticket_number": number,"ticket_prefix": string,"version": number,"allowed_actions": (Database["api"]['Enums']["visit_action"])[] | null
                  }
                  ComputedFields: "allowed_actions"
                  Insert: {
                    "anonymized_at"?: string | null,"arrive_after"?: string | null,"assigned_counter_id"?: string | null,"assigned_staff_id"?: string | null,"attribution"?: string | null,"call_count"?: number,"called_at"?: string | null,"contact_id"?: string | null,"counter_id"?: string | null,"device_key_hash"?: string | null,"device_ref_hash"?: string | null,"display_ticket": string,"eta_quoted_high"?: number | null,"eta_quoted_low"?: number | null,"finished_at"?: string | null,"grace_until"?: string | null,"group_key"?: string | null,"guest_email"?: string | null,"guest_id"?: string | null,"guest_name"?: string | null,"guest_phone_e164"?: string | null,"guest_token_hash": string,"id"?: string,"idempotency_key": string,"joined_at"?: string,"journey_id"?: string | null,"locale"?: string,"location_id": string,"manually_ordered"?: boolean,"notes"?: string | null,"org_id": string,"party_size"?: number,"priority_class_id"?: string | null,"queue_id": string,"scan_code"?: string | null,"scheduled_at"?: string | null,"service_day": string,"service_id"?: string | null,"serving_at"?: string | null,"snooze_count"?: number,"sort_key": number,"source": string,"status": Database["api"]['Enums']["visit_state"],"tags"?: (string)[],"ticket_number": number,"ticket_prefix": string,"version"?: number
                  }
                  Update: {
                    "anonymized_at"?: string | null,"arrive_after"?: string | null,"assigned_counter_id"?: string | null,"assigned_staff_id"?: string | null,"attribution"?: string | null,"call_count"?: number,"called_at"?: string | null,"contact_id"?: string | null,"counter_id"?: string | null,"device_key_hash"?: string | null,"device_ref_hash"?: string | null,"display_ticket"?: string,"eta_quoted_high"?: number | null,"eta_quoted_low"?: number | null,"finished_at"?: string | null,"grace_until"?: string | null,"group_key"?: string | null,"guest_email"?: string | null,"guest_id"?: string | null,"guest_name"?: string | null,"guest_phone_e164"?: string | null,"guest_token_hash"?: string,"id"?: string,"idempotency_key"?: string,"joined_at"?: string,"journey_id"?: string | null,"locale"?: string,"location_id"?: string,"manually_ordered"?: boolean,"notes"?: string | null,"org_id"?: string,"party_size"?: number,"priority_class_id"?: string | null,"queue_id"?: string,"scan_code"?: string | null,"scheduled_at"?: string | null,"service_day"?: string,"service_id"?: string | null,"serving_at"?: string | null,"snooze_count"?: number,"sort_key"?: number,"source"?: string,"status"?: Database["api"]['Enums']["visit_state"],"tags"?: (string)[],"ticket_number"?: number,"ticket_prefix"?: string,"version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "visits_journey_id_fkey"
      columns: ["journey_id"]
isOneToOne: false
      referencedRelation: "journeys"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "visits_org_id_contact_id_fkey"
      columns: ["org_id","contact_id"]
isOneToOne: false
      referencedRelation: "guest_contacts"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visits_org_id_guest_id_fkey"
      columns: ["org_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visits_org_id_location_id_assigned_counter_id_fkey"
      columns: ["org_id","location_id","assigned_counter_id"]
isOneToOne: false
      referencedRelation: "counters"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "visits_org_id_location_id_counter_id_fkey"
      columns: ["org_id","location_id","counter_id"]
isOneToOne: false
      referencedRelation: "counters"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "visits_org_id_location_id_queue_id_fkey"
      columns: ["org_id","location_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "visits_org_id_priority_class_id_fkey"
      columns: ["org_id","priority_class_id"]
isOneToOne: false
      referencedRelation: "priority_classes"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visits_org_id_queue_id_service_id_fkey"
      columns: ["org_id","queue_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","queue_id","id"]
    }
                  ]
                },"waiver_acceptances": {
                  Row: {
                    "accepted_at": string,"created_at": string,"field_key": string,"form_response_id": string,"form_version_id": string,"guardian_name": string | null,"id": string,"location_id": string,"org_id": string,"signed_at": string | null,"subject_id": string,"subject_kind": string,"text_hash": string,"typed_name": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at": string,"created_at"?: string,"field_key": string,"form_response_id": string,"form_version_id": string,"guardian_name"?: string | null,"id"?: string,"location_id": string,"org_id": string,"signed_at"?: string | null,"subject_id": string,"subject_kind": string,"text_hash": string,"typed_name"?: string | null
                  }
                  Update: {
                    "accepted_at"?: string,"created_at"?: string,"field_key"?: string,"form_response_id"?: string,"form_version_id"?: string,"guardian_name"?: string | null,"id"?: string,"location_id"?: string,"org_id"?: string,"signed_at"?: string | null,"subject_id"?: string,"subject_kind"?: string,"text_hash"?: string,"typed_name"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "waiver_acceptances_org_id_form_version_id_fkey"
      columns: ["org_id","form_version_id"]
isOneToOne: false
      referencedRelation: "form_versions"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "waiver_acceptances_org_id_location_id_fkey"
      columns: ["org_id","location_id"]
isOneToOne: false
      referencedRelation: "locations"
      referencedColumns: ["org_id","id"]
    }
                  ]
                },"webhook_deliveries": {
                  Row: {
                    "attempts": number,"created_at": string,"endpoint_id": string,"error": string | null,"event_id": string,"event_type": string,"id": string,"locked_until": string | null,"next_attempt_at": string,"org_id": string,"payload": NonNullable<Json>,"response_ms": number | null,"response_status": number | null,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"created_at"?: string,"endpoint_id": string,"error"?: string | null,"event_id": string,"event_type": string,"id"?: string,"locked_until"?: string | null,"next_attempt_at"?: string,"org_id": string,"payload": NonNullable<Json>,"response_ms"?: number | null,"response_status"?: number | null,"status"?: string
                  }
                  Update: {
                    "attempts"?: number,"created_at"?: string,"endpoint_id"?: string,"error"?: string | null,"event_id"?: string,"event_type"?: string,"id"?: string,"locked_until"?: string | null,"next_attempt_at"?: string,"org_id"?: string,"payload"?: NonNullable<Json>,"response_ms"?: number | null,"response_status"?: number | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "webhook_deliveries_endpoint_id_fkey"
      columns: ["endpoint_id"]
isOneToOne: false
      referencedRelation: "webhook_endpoints"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "webhook_deliveries_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"webhook_endpoints": {
                  Row: {
                    "active": boolean,"alert_thresholds": NonNullable<Json>,"consecutive_failures": number,"created_at": string,"created_by": string | null,"disabled_reason": string | null,"event_types": (string)[],"id": string,"include_guest_name": boolean,"kind": string,"org_id": string,"prev_secret_expires_at": string | null,"prev_vault_secret_id": string | null,"url": string,"vault_secret_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "active"?: boolean,"alert_thresholds"?: NonNullable<Json>,"consecutive_failures"?: number,"created_at"?: string,"created_by"?: string | null,"disabled_reason"?: string | null,"event_types": (string)[],"id"?: string,"include_guest_name"?: boolean,"kind"?: string,"org_id": string,"prev_secret_expires_at"?: string | null,"prev_vault_secret_id"?: string | null,"url": string,"vault_secret_id": string
                  }
                  Update: {
                    "active"?: boolean,"alert_thresholds"?: NonNullable<Json>,"consecutive_failures"?: number,"created_at"?: string,"created_by"?: string | null,"disabled_reason"?: string | null,"event_types"?: (string)[],"id"?: string,"include_guest_name"?: boolean,"kind"?: string,"org_id"?: string,"prev_secret_expires_at"?: string | null,"prev_vault_secret_id"?: string | null,"url"?: string,"vault_secret_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "webhook_endpoints_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"whatsapp_templates": {
                  Row: {
                    "created_at": string,"id": string,"org_id": string,"status": string,"synced_at": string | null,"template_id": string,"wa_category": string,"wa_language": string,"wa_name": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"org_id": string,"status"?: string,"synced_at"?: string | null,"template_id": string,"wa_category": string,"wa_language": string,"wa_name": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"org_id"?: string,"status"?: string,"synced_at"?: string | null,"template_id"?: string,"wa_category"?: string,"wa_language"?: string,"wa_name"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "whatsapp_templates_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "whatsapp_templates_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "notification_templates"
      referencedColumns: ["id"]
    }
                  ]
                }
          }
          Views: {
            "credit_balance": {
                  Row: {
                    "balance_micros": number | null,"org_id": string
                  }
                  ComputedFields: never
                  Relationships: [
                    {
      foreignKeyName: "credit_ledger_org_id_fkey"
      columns: ["org_id"]
isOneToOne: false
      referencedRelation: "organizations"
      referencedColumns: ["id"]
    }
                  ]
                },"staff_visits": {
                  Row: {
                    "allowed_actions": (Database["api"]['Enums']["visit_action"])[] | null,"arrival_early_until": string | null,"arrival_late_after": string | null,"arrive_after": string | null,"assigned_counter_id": string | null,"assigned_staff_id": string | null,"call_count": number,"called_at": string | null,"contact_id": string | null,"counter_id": string | null,"display_ticket": string,"eta_quoted_high": number | null,"eta_quoted_low": number | null,"finished_at": string | null,"group_key": string | null,"guest_email": string | null,"guest_id": string | null,"guest_name": string | null,"guest_phone_e164": string | null,"id": string,"joined_at": string,"journey_id": string | null,"journey_next_queue_id": string | null,"locale": string,"location_id": string,"notes": string | null,"on_the_way": boolean | null,"org_id": string,"party_size": number,"priority_class_id": string | null,"queue_id": string,"scheduled_at": string | null,"service_day": string,"service_id": string | null,"serving_at": string | null,"sort_key": number,"source": string,"status": Database["api"]['Enums']["visit_state"],"tags": (string)[],"ticket_number": number,"ticket_prefix": string,"version": number
                  }
                  ComputedFields: never
                  Insert: {
                           "allowed_actions"?: never,"arrival_early_until"?: never,"arrival_late_after"?: never,"arrive_after"?: string | null,"assigned_counter_id"?: string | null,"assigned_staff_id"?: string | null,"call_count"?: number | null,"called_at"?: string | null,"contact_id"?: string | null,"counter_id"?: string | null,"display_ticket"?: string | null,"eta_quoted_high"?: number | null,"eta_quoted_low"?: number | null,"finished_at"?: string | null,"group_key"?: string | null,"guest_email"?: string | null,"guest_id"?: string | null,"guest_name"?: string | null,"guest_phone_e164"?: string | null,"id"?: string | null,"joined_at"?: string | null,"journey_id"?: string | null,"journey_next_queue_id"?: never,"locale"?: string | null,"location_id"?: string | null,"notes"?: string | null,"on_the_way"?: never,"org_id"?: string | null,"party_size"?: number | null,"priority_class_id"?: string | null,"queue_id"?: string | null,"scheduled_at"?: string | null,"service_day"?: string | null,"service_id"?: string | null,"serving_at"?: string | null,"sort_key"?: number | null,"source"?: string | null,"status"?: Database["api"]['Enums']["visit_state"] | null,"tags"?: (string)[] | null,"ticket_number"?: number | null,"ticket_prefix"?: string | null,"version"?: number | null
                         }
                        Update: {
                           "allowed_actions"?: never,"arrival_early_until"?: never,"arrival_late_after"?: never,"arrive_after"?: string | null,"assigned_counter_id"?: string | null,"assigned_staff_id"?: string | null,"call_count"?: number | null,"called_at"?: string | null,"contact_id"?: string | null,"counter_id"?: string | null,"display_ticket"?: string | null,"eta_quoted_high"?: number | null,"eta_quoted_low"?: number | null,"finished_at"?: string | null,"group_key"?: string | null,"guest_email"?: string | null,"guest_id"?: string | null,"guest_name"?: string | null,"guest_phone_e164"?: string | null,"id"?: string | null,"joined_at"?: string | null,"journey_id"?: string | null,"journey_next_queue_id"?: never,"locale"?: string | null,"location_id"?: string | null,"notes"?: string | null,"on_the_way"?: never,"org_id"?: string | null,"party_size"?: number | null,"priority_class_id"?: string | null,"queue_id"?: string | null,"scheduled_at"?: string | null,"service_day"?: string | null,"service_id"?: string | null,"serving_at"?: string | null,"sort_key"?: number | null,"source"?: string | null,"status"?: Database["api"]['Enums']["visit_state"] | null,"tags"?: (string)[] | null,"ticket_number"?: number | null,"ticket_prefix"?: string | null,"version"?: number | null
                         }
                        Relationships: [
                    {
      foreignKeyName: "visits_journey_id_fkey"
      columns: ["journey_id"]
isOneToOne: false
      referencedRelation: "journeys"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "visits_org_id_contact_id_fkey"
      columns: ["org_id","contact_id"]
isOneToOne: false
      referencedRelation: "guest_contacts"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visits_org_id_guest_id_fkey"
      columns: ["org_id","guest_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visits_org_id_location_id_assigned_counter_id_fkey"
      columns: ["org_id","location_id","assigned_counter_id"]
isOneToOne: false
      referencedRelation: "counters"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "visits_org_id_location_id_counter_id_fkey"
      columns: ["org_id","location_id","counter_id"]
isOneToOne: false
      referencedRelation: "counters"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "visits_org_id_location_id_queue_id_fkey"
      columns: ["org_id","location_id","queue_id"]
isOneToOne: false
      referencedRelation: "queues"
      referencedColumns: ["org_id","location_id","id"]
    },{
      foreignKeyName: "visits_org_id_priority_class_id_fkey"
      columns: ["org_id","priority_class_id"]
isOneToOne: false
      referencedRelation: "priority_classes"
      referencedColumns: ["org_id","id"]
    },{
      foreignKeyName: "visits_org_id_queue_id_service_id_fkey"
      columns: ["org_id","queue_id","service_id"]
isOneToOne: false
      referencedRelation: "services"
      referencedColumns: ["org_id","queue_id","id"]
    }
                  ]
                }
          }
          Functions: {
            "allowed_actions":
{ Args: { "v": Omit<Database["app"]['Tables']["visits"]['Row'], Database["app"]['Tables']["visits"]['ComputedFields']> }; Returns: (Database["api"]['Enums']["visit_action"])[]
                           },
"online_joins_paused_until":
{ Args: { "p_queue": Omit<Database["app"]['Tables']["queues"]['Row'], Database["app"]['Tables']["queues"]['ComputedFields']> }; Returns: string
                           }
          }
          Enums: {
            "actor_kind": "staff"|"guest"|"device"|"system"|"platform"|"api_key","announcement_severity": "info"|"warning"|"maintenance","appointment_status": "booked"|"cancelled"|"checked_in"|"no_show"|"completed"|"offered"|"pending_payment","assignment_strategy": "none"|"round_robin"|"least_busy","availability_kind": "unavailable"|"extra","capacity_scope": "slot"|"day","contact_channel": "phone"|"email"|"telegram","device_kind": "display"|"kiosk","event_status": "scheduled"|"cancelled","incident_status": "suspected"|"contained"|"resolved","intake_field_type": "text"|"select"|"checkbox"|"phone"|"number"|"date","intake_sensitivity": "normal"|"personal"|"sensitive","intake_visibility": "guest"|"staff_only","join_restriction": "none"|"onsite_code"|"geofence","member_role": "staff"|"manager"|"admin"|"owner","message_category": "transactional"|"marketing","notification_channel": "push"|"email"|"sms"|"whatsapp"|"console"|"telegram","notification_status": "queued"|"claimed"|"sent"|"failed"|"dead"|"suppressed","org_status": "active"|"suspended"|"pending_deletion","payment_status": "created"|"held"|"captured"|"released"|"failed","platform_role": "support"|"operator","priority_condition": "source"|"intake_answer","resource_kind": "counter"|"desk"|"room"|"table"|"chair"|"staff","signage_kind": "image"|"text","single_active_scope": "off"|"location"|"org","support_scope": "read"|"act","waitlist_status": "waiting"|"offered"|"claimed"|"expired"|"cancelled"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "api">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "api": {
          Enums: {
            "eta_state": ["hidden", "paused", "unstaffed", "next", "over_hour", "ok", "uncertain", "override"],"guest_action": ["leave", "on_my_way", "need_more_time", "check_in", "undo_leave"],"queue_state": ["open", "paused", "closed"],"visit_action": ["call", "recall", "start", "requeue", "complete", "no_show", "cancel", "remove", "reinstate", "expire", "check_in"],"visit_state": ["expected", "waiting", "called", "serving", "served", "no_show", "cancelled", "removed", "expired"]
          }
        },"app": {
          Enums: {
            "actor_kind": ["staff", "guest", "device", "system", "platform", "api_key"],"announcement_severity": ["info", "warning", "maintenance"],"appointment_status": ["booked", "cancelled", "checked_in", "no_show", "completed", "offered", "pending_payment"],"assignment_strategy": ["none", "round_robin", "least_busy"],"availability_kind": ["unavailable", "extra"],"capacity_scope": ["slot", "day"],"contact_channel": ["phone", "email", "telegram"],"device_kind": ["display", "kiosk"],"event_status": ["scheduled", "cancelled"],"incident_status": ["suspected", "contained", "resolved"],"intake_field_type": ["text", "select", "checkbox", "phone", "number", "date"],"intake_sensitivity": ["normal", "personal", "sensitive"],"intake_visibility": ["guest", "staff_only"],"join_restriction": ["none", "onsite_code", "geofence"],"member_role": ["staff", "manager", "admin", "owner"],"message_category": ["transactional", "marketing"],"notification_channel": ["push", "email", "sms", "whatsapp", "console", "telegram"],"notification_status": ["queued", "claimed", "sent", "failed", "dead", "suppressed"],"org_status": ["active", "suspended", "pending_deletion"],"payment_status": ["created", "held", "captured", "released", "failed"],"platform_role": ["support", "operator"],"priority_condition": ["source", "intake_answer"],"resource_kind": ["counter", "desk", "room", "table", "chair", "staff"],"signage_kind": ["image", "text"],"single_active_scope": ["off", "location", "org"],"support_scope": ["read", "act"],"waitlist_status": ["waiting", "offered", "claimed", "expired", "cancelled"]
          }
        }
} as const
