-- Split terms "acknowledged as read" (enquiry checkbox) from formal
-- acceptance (recorded by Amanda when the customer agrees the arrangements).
-- RENAME preserves existing data: everything recorded so far was the
-- enquiry-time checkbox, i.e. an acknowledgement.
ALTER TABLE enquiries RENAME COLUMN terms_accepted_at TO terms_acknowledged_at;
ALTER TABLE enquiries ADD COLUMN accepted_terms_version TEXT;
ALTER TABLE enquiries ADD COLUMN accepted_at TEXT;
ALTER TABLE enquiries ADD COLUMN acceptance_method TEXT;
