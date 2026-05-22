# Sqlite database sync scenarios

Every time the app is opened, we need to sync the database.

Also, for the cases when the app is ran on a mobile device, we need to check roaming status. 
If it's roaming (or a metered connection), expose the button to sync the database manually (if the sync is needed), but never sync it automatically.
If the app is on wifi or in home network, sync it automatically when needed, according to the rules below. 

## 1. No sync needed

Device A opens the app, and the remote database is the same as the local database. In this scenario, no sync is needed.

Rule: Check the hash – if it's the same, don't sync.

## 2. Sync needed

Device A opens the app, and the remote database timestamp is different from the local database.

Rule: Hashes are different – check the last modifying user and the timestamp.

### 2.1. Last person that modified the database is the user A

We trust the device A has its own time consistent. The timestamp is to be stored in UTC to make sure when the user travels across time zones, there won't be any problem.
Just in case, maintain an epsilon of five seconds to account for clock drift.
If the device A is the last person to modify the database, and the remote database is older, don't sync. It means the local database is the most up-to-date.
If the remote database is newer, sync it.

Rule: device A is last modifier, and the remote database is older, don't sync.

### 2.2. Last person that modified the database is not the user A

It doesn't matter what the timestamp is. Just sync it.
Rule: If the remote database was modified by a different device, always sync it.



# Sync algorithm overview

Once the app opens, check if network allows for database sync.
If it's allowed, read the metadata, and decide what to do according to the rules above.
If the sync is needed or is manually triggered:

1. Download the remote database somenwhere locally and open it.
2. Open the local database too.
3. Take the earliest modified timestamp of the two databases.
4. For all entries in all tables that have created_at, modified_at or deleted_at greater than this timestamp:
   5. Update/insert/mark-deleted the entry into the local database.
   6. If there seems to be a conflict, resolve it by taking the latest version, and send an email to the user. (to be implemented later)
7. Update the remote database with the local database that is now up-to-date.
8. Unblock the app, now the user can add new expenditures.

## Abstract sync provider API

The abstract sync provider should grant read-write access to:
- sqlite database
- what device last uploaded the database
- when the database was uploaded
- hash of the database

Preferably, atomically, like git commit.
