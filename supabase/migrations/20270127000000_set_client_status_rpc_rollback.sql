-- Rollback for 20270127000000_set_client_status_rpc.sql — revert the frontend first
-- (handleUpdateClientStatus back to a direct clients UPDATE), then drop the function.
drop function if exists public.set_client_status(text, text);
