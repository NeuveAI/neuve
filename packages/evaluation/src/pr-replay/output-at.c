#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

int output_openat(int parent, const char *name, int flags, unsigned int mode) {
    struct stat before, opened, after;
    int directory = flags & O_DIRECTORY;
    if (directory) {
        if (fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW) < 0) return -1;
        if (!S_ISDIR(before.st_mode)) { errno = ENOTDIR; return -1; }
    }
    int fd = openat(parent, name, flags | O_CLOEXEC, mode);
    if (fd < 0 || !directory) return fd;
    if (fstat(fd, &opened) < 0 ||
        fstatat(parent, name, &after, AT_SYMLINK_NOFOLLOW) < 0) {
        int error = errno;
        close(fd);
        errno = error;
        return -1;
    }
    if (!S_ISDIR(opened.st_mode) || !S_ISDIR(after.st_mode) ||
        before.st_dev != opened.st_dev || before.st_ino != opened.st_ino ||
        after.st_dev != opened.st_dev || after.st_ino != opened.st_ino) {
        close(fd);
        errno = ESTALE;
        return -1;
    }
    return fd;
}

int output_cloexec(int fd) { return fcntl(fd, F_GETFD); }
