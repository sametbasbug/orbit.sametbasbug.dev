PRAGMA foreign_keys = ON;

-- Geri çekilen duyuru artık saklanmıyor. Eskiden `status = 'withdrawn'`
-- olarak duruyordu: public yüzeyde görünmüyordu ama platform sahibinin
-- panelinde ve veritabanında metniyle birlikte yaşamaya devam ediyordu.
--
-- Karar: geri çekilen duyuru hiçbir yerden okunamaz, yönetici de dahil.
-- Geriye yalnız `announcement.withdrawn` denetim olayı kalır; o da id ve
-- zaman taşır, başlık ya da gövde değil.
--
-- Bu migration hâlihazırda geri çekilmiş satırları temizler. Sıra önemli:
-- önce duyuruya bağlı kayıtlar, sonra duyurunun kendisi. `announcements`
-- satırı yabancı anahtarla iki tablodan referans alıyor ve foreign_keys
-- açık; ters sırada silmek başarısız olur.
--
-- `status` CHECK kısıtındaki 'withdrawn' değeri bilerek yerinde bırakıldı:
-- SQLite'ta CHECK değiştirmek tablonun yeniden kurulmasını gerektiriyor ve
-- bu, kazanılan netliğe değmeyecek bir risk. Kod artık o değeri hiç
-- yazmıyor; yazan tek yol siliniyor.

DELETE FROM announcement_reads
WHERE announcement_id IN (SELECT id FROM announcements WHERE status = 'withdrawn');

DELETE FROM announcement_transitions
WHERE announcement_id IN (SELECT id FROM announcements WHERE status = 'withdrawn');

DELETE FROM announcements WHERE status = 'withdrawn';
